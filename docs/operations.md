# Operations guide

Things to remember while running the API in production. This is the short list. The detailed procedures are in
[deployment-gcp.md](deployment-gcp.md) (especially [§6 Client IP and abuse limits](deployment-gcp.md#6-client-ip-and-abuse-limits)),
and the client contract is in [api.md](api.md).

## 1. One-time setup

- [ ] **Alerts** ([log-based alerts](https://cloud.google.com/logging/docs/alerting/log-based-alerts)) on:
  - `jsonPayload.event="chat_limit_reached" AND jsonPayload.scope="global"`: anonymous chat is off for everyone until
    midnight UTC (heavy use, or an attack).
  - `jsonPayload.event="client_ip_unknown"`: the API can't see visitor IPs, so the per-IP limit is skipped. Never expected on Cloud Run.
- [ ] **Spending brakes:** a billing budget with alerts, and Vertex AI quota limits for Gemini and the embedding model.
  Budget alerts only notify; quota limits actually stop spending.
- [ ] **Cloud SQL timezone is UTC** (`SHOW timezone;`). Daily limits reset at midnight UTC.
- [ ] **Privacy policy and retention** (see [§5](#5-privacy-and-compliance)).

## 2. Every release

1. Deploy the new version **as a candidate revision without traffic**, and run Check 1 and the pre-traffic form of Check 2 against
   its URL ([procedure](deployment-gcp.md#verify-before-a-release-gets-traffic)).
2. Move traffic to it.
3. After real traffic (e.g. the next day), run the full Check 2 query
   ([§6](deployment-gcp.md#verify-after-deploying-and-after-any-change-in-front-of-the-api)).

Run the same checks **whenever anything changes in front of the API** (load balancer, CDN, custom domain, Firebase Hosting,
moving off Cloud Run), and update `TRUST_PROXY_HOPS` first
([what to change](deployment-gcp.md#revisit-trust_proxy_hops-whenever-the-path-to-the-api-changes)).

## 3. Regular review (e.g. monthly)

- **Global anonymous cap vs. real use.** Keep `ANON_GLOBAL_DAILY_LIMIT` a few times above normal daily volume:
  ```sql
  SELECT query_date, count FROM chat_usage WHERE identity = 'global:anon' ORDER BY query_date DESC LIMIT 30;
  ```
- **How often the per-network limit is hit** (`chat_limit_reached`, `scope="ip"`). Occasional hits are normal: offices,
  campuses, and mobile carriers that put many users behind one IP (carrier-grade NAT), plus people rotating sessions. A steady rise as
  traffic grows means 20/day is getting tight for shared networks. Raise `ANON_IP_DAILY_LIMIT`.
- **Check 2 query** (distinct networks vs. sessions). This catches a proxy added without updating `TRUST_PROXY_HOPS`.
- **Answer sizes and cost** (`chat_answer` logs, see [§3a](#3a-chat-answer-logs)). If more than a few percent of answers are
  `truncated`, raise `ANSWER_MAX_TOKENS`. If `timeout` shows up regularly, look at Gemini latency before raising
  `GENERATION_TIMEOUT_MS`. Both are in `src/api/chat-generation.ts`.

### 3a. Chat answer logs

Every chat question that reaches Gemini writes one structured log line, with no message content and no identity:

```json
{"event":"chat_answer","outcome":"completed","identity_type":"anon","duration_ms":5234,
 "prompt_tokens":9120,"thinking_tokens":410,"answer_tokens":820}
```

| `outcome` | Meaning | Counted toward the daily limit? |
|---|---|---|
| `completed` | Answer finished | yes |
| `truncated` | Answer hit the length limit (about 4,096 tokens). The user was told to ask Cora to continue | yes |
| `client_disconnected` | The visitor left before the answer finished | yes (Gemini was already working on it) |
| `timeout` | No complete answer within 2 minutes | only if part of the answer was sent |
| `error` | Gemini failed | only if part of the answer was sent |

Token counts are `null` when Gemini didn't report usage (e.g. it failed before answering). Cost estimate per answer:
`prompt_tokens × input price + (thinking_tokens + answer_tokens) × output price`. Thinking is billed as output.

**How often answers are truncated** (the number to tune `ANSWER_MAX_TOKENS` on): count outcomes over a period and
compare `truncated` with the total:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="chat_answer"' \
  --project=$PROJECT_ID --freshness=7d --format='value(jsonPayload.outcome)' | sort | uniq -c
#  412 completed
#    9 truncated        -> about 2% of answers
#    3 client_disconnected
```

All fields, e.g. to look at token usage of truncated answers or estimate cost:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="chat_answer"' \
  --project=$PROJECT_ID --freshness=7d \
  --format='csv(timestamp, jsonPayload.outcome, jsonPayload.prompt_tokens, jsonPayload.thinking_tokens, jsonPayload.answer_tokens, jsonPayload.duration_ms)'
```

For a dashboard or alert instead of ad-hoc queries, create a
[log-based counter metric](https://cloud.google.com/logging/docs/logs-based-metrics/counter-metrics) on
`jsonPayload.event="chat_answer"` with a label extracted from `jsonPayload.outcome`.

## 4. Analytics on `chat_usage`

`chat_usage` is for enforcing limits, not an event log. One row per identity per UTC day, holding that day's count:

| `identity_type` | Row is | Use for analytics? |
|---|---|---|
| `user` | a signed-in user (Firebase UID) | yes |
| `anon` | an anonymous browser session (`X-Session-ID`) | yes. A session is a browser profile, not a person |
| `ip` | all anonymous sessions from one network (keyed hash) | **no**: counts the same questions again |
| `global` | all anonymous questions that day | **no**: counts the same questions again (though it is a quick total) |

So always filter to `identity_type IN ('user', 'anon')` when counting people or questions:

```sql
SELECT query_date, identity_type, COUNT(*) AS people, SUM(count) AS questions
FROM chat_usage WHERE identity_type IN ('user', 'anon')
GROUP BY 1, 2 ORDER BY 1 DESC, 2;
```

Other things that affect the numbers:
- A question that failed before any answer text was streamed is given back, so it isn't in the counts.
- Questions rejected by a limit leave no trace.
- `ip` rows can't be linked across days (the hash includes the date).

## 5. Privacy and compliance

*A summary for whoever owns privacy/legal. It isn't legal advice, so have it confirmed.*

**What the API processes about visitors:**

| Data | Where | Kept |
|---|---|---|
| Firebase UID, email | `users` | until deleted (no account-deletion flow yet) |
| Anonymous session id (random UUID made by the browser, kept in `localStorage` as `cc_session_id`) | `chat_usage` (`anon` rows) | indefinitely (no retention job yet) |
| Visitor IP, **as a keyed hash** of date + IP (IPv6: /64 prefix) | `chat_usage` (`ip` rows) | indefinitely (no retention job yet) |
| Visitor IP, **raw** | Cloud Run request logs (standard Google Cloud logging, not this code) | Cloud Logging retention (30 days by default) |
| Chat messages and history | sent to Gemini (Vertex AI) to generate the answer; not stored by the API | — |

**Points to be aware of:**
- **The hashed IPs are still personal data.** Under GDPR, IP addresses are personal data, and a keyed hash is
  *pseudonymised* data, not anonymous data: we hold the key, so for a known IP and date we could recompute the hash.
  Hashing reduces risk (a leaked table doesn't reveal IPs, and rows can't be linked across days), but the GDPR still
  applies. The same goes for session ids and Firebase UIDs.
- **Lawful basis:** preventing abuse and fraud and keeping the service secure are commonly relied on as *legitimate
  interests* (GDPR Art. 6(1)(f), Recitals 47 and 49). Write a short legitimate-interest assessment: purpose (stop
  free-question abuse that drives AI costs), necessity (a per-network counter is the least data that works without
  sign-in), safeguards (keyed hash, daily key change, no raw IPs stored, short retention).
- **Transparency:** the privacy policy should say that IP addresses are processed in pseudonymised form to limit abuse of
  the free chat, along with the retention period.
- **Retention (most important action item):** the counters are only needed for the current day, plus the previous day,
  because a question near midnight is refunded to its own day. Rows older than that serve no limiting purpose. The
  `chat_usage` retention task in the README To do list is now more pressing because of the `ip` rows. A short period
  (e.g. 7 days, if you want a week of aggregate numbers first) is easy to justify.
- **Data subject requests:** we can't find a person's `ip` rows without their IP and the dates, and we don't need to
  identify people to run the limits (GDPR Art. 11 covers this case). Deleting a signed-in user should also delete their
  `chat_usage` rows, once account deletion exists.
- **Browser storage (frontend):** `cc_session_id` in `localStorage` counts as storing information on the visitor's
  device under the ePrivacy rules. It is arguably *strictly necessary* for the chat the visitor uses (so no consent
  needed), but the cookie/storage notice should list it. Have legal confirm.
- **Secrets:** the IP-hash key is derived from `JWT_SECRET`. If that secret leaks, stored IP hashes could be reversed by
  brute force, which is one more reason to treat it as sensitive and rotate it if exposed.

## 6. Constraints to keep in mind

- **`POST /api/v1/chat` must be called from the browser**, never relayed through the Next.js server (API route,
  server action, rewrite). Otherwise all visitors share one per-network limit. Today the Next.js server calls
  `POST /auth/refresh`, `POST /auth/logout`, `GET /resources/:id`, `GET /subjects` and `GET /subjects/:slug`
  (course and subject details are also fetched from the browser after the page renders).
- **Anything added in front of the API** changes how visitor IPs are worked out (§2 above).
- **The frontend must keep `cc_session_id` stable** (one `crypto.randomUUID()`, reused) and shouldn't make a new one when a
  limit is reached.

## 7. What can be tested before deploying

| What | `npm test` | Local simulation¹ | Candidate revision (no traffic) | Live traffic |
|---|---|---|---|---|
| Limit logic, messages, `Retry-After`, input limits, settings validation | ✓ | ✓ | ✓ | |
| IP parsing, hop counting, IPv6 grouping, faked entries ignored | ✓ (unit) | ✓ (through a proxy) | ✓ (Check 1) | |
| Exact limits under concurrency on **real Postgres** (connection pool, row locks, no deadlocks) | partly (PGlite has one connection) | ✓ | | |
| **Cloud Run's front end really appends the visitor IP last** (the main assumption) | | | ✓ (Check 1) | |
| Visitors on different networks get different counters (hops not too low) | | | ✓ (two-network check) | ✓ (Check 2) |
| Logs appear in Cloud Logging with `severity` and `jsonPayload.event` | | | ✓ (the 21st request of Check 1 logs `chat_limit_reached`) | |
| Real Gemini / Vertex behaviour | | | ✓ | ✓ |

¹ Not part of the repo yet. For Step 2 the built app was run against a real Postgres 16, behind a small proxy that adds
`X-Forwarded-For` like Cloud Run's front end, with Gemini stubbed. Making that a repeatable `npm run test:e2e` is
a possible follow-up.
