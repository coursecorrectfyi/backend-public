# Operations guide

Things to remember while running the API in production. This is the short list. The detailed procedures are in
[deployment-gcp.md](deployment-gcp.md) (especially [§6 Client IP and abuse limits](deployment-gcp.md#6-client-ip-and-abuse-limits)),
alerts and spending brakes in [monitoring.md](monitoring.md), and the client contract in [api.md](api.md).

## First release of the hardening changes (one-time)

The first deploy with the abuse and cost hardening (chat limits, body and input limits, per-minute rate limits,
sign-in rules) changes the API contract and adds settings. Follow this once. Afterwards, §2 covers every release.

| When | What |
|---|---|
| **Before** | 1. **The frontend matches the contract.** Check it against the whole of [api.md](api.md), which is complete on its own (don't rely on the changelog for this). Release the frontend's changes before or together with the backend. |
| | 1a. **The relay secret exists and the frontend has it:** the two Secret Manager secrets `trusted-relay-secrets` (API) and `relay-secret` (frontend), with the same value, and the frontend sends `X-Relay-Secret` + `X-Visitor-IP` on every call it makes for a visitor ([deployment-gcp.md §6](deployment-gcp.md#trusted-relay-the-nextjs-server)). The API deploy fails if `trusted-relay-secrets` doesn't exist. |
| | 2. **Monitoring:** at least the notification channels, the two budgets and the log alert from [monitoring.md](monitoring.md#at-a-glance), so you see what the release does. |
| | 3. **Cloud SQL timezone is UTC** (`SHOW timezone;`). |
| | 4. **Apply the database migrations** (`npx drizzle-kit migrate`, [procedure](deployment-gcp.md#migrations)). The only new one adds the `chat_usage_daily` table: additive, so it's safe to apply before the new code is live. |
| | 5. **Current chat volume is well below the new daily totals** (1,000 anonymous and 1,000 signed-in questions a day by default). If not, raise `_ANON_GLOBAL_DAILY_LIMIT` / `_SIGNED_IN_GLOBAL_DAILY_LIMIT` first: `SELECT query_date, identity_type, SUM(count) AS questions FROM chat_usage WHERE identity_type IN ('user', 'anon') AND query_date >= CURRENT_DATE - 30 GROUP BY 1, 2 ORDER BY 1 DESC;` |
| **Release day** | 6. Candidate revision without traffic, **Checks 1–4**, then move traffic ([procedure](deployment-gcp.md#verify-before-a-release-gets-traffic)). The per-minute limits start in **shadow mode** (the `cloudbuild.api.yaml` default). |
| | 7. In the first hour: no `login_rejected` for Google users, no `proxy_hops_mismatch`, no `relay_auth_failed`, and no new errors ([log events](monitoring.md#log-events-reference)). |
| | 8. **Create and schedule the `chat-usage-retention` job** with the new image ([deployment-gcp.md §3](deployment-gcp.md#3-batch-jobs)), and run it once by hand: `gcloud run jobs execute chat-usage-retention --region=$REGION --wait`. The first run summarizes all existing history into `chat_usage_daily` and deletes raw rows older than 7 days. |
| **Day 1–2** | 9. Check 5 (relayed calls count per visitor) and the full Check 2 query ([§6](deployment-gcp.md#verify-after-deploying-and-after-any-change-in-front-of-the-api)), and a first glance at the `rate_limit_summary` lines, to catch a badly wrong budget early. |
| **Day 7** (no later than day 14) | 10. Review the shadow period and **switch the per-minute limits to enforce**, in the service and in `cloudbuild.api.yaml`, then Check 3 in its enforce form ([procedure](deployment-gcp.md#rolling-out-the-per-minute-limits-shadow--enforce)). Leaving shadow on longer means the limits protect nothing. |
| **After** | 11. §1 and the monthly review in §3. |

## 1. One-time setup

- [ ] **Monitoring, alerts and spending brakes:** the "Do now" list in [monitoring.md](monitoring.md#at-a-glance).
  Notification channels, two billing budgets, the embedding quota cap, an uptime check, one log alert for abuse and
  configuration signals (global chat cap reached, `client_ip_unknown`, `proxy_hops_mismatch`, floods), and Error
  Reporting notifications. All free except two alert conditions (a few dollars a month at most). Budgets only notify;
  the quota cap and the in-app limits actually stop spending.
- [ ] **Cloud SQL timezone is UTC** (`SHOW timezone;`). Daily limits reset at midnight UTC.
- [ ] **The `chat-usage-retention` job runs daily** (Cloud Scheduler, [deployment-gcp.md §3](deployment-gcp.md#scheduling)).
  Without it, pseudonymous identifiers pile up in `chat_usage` indefinitely.
- [ ] **Switch the per-minute rate limits from shadow to enforce** 7 days after the first release (no later than 14),
  once the `rate_limit_summary` logs show nobody legitimate would be blocked
  ([procedure](deployment-gcp.md#rolling-out-the-per-minute-limits-shadow--enforce)).
- [ ] **Privacy policy and retention** (see [§5](#5-privacy-and-compliance)).

## 2. Every release

0. **If `migrations/` has new files since the last release:** apply them **before** deploying, and check they're
   compatible with the version still running ([procedure and rules](deployment-gcp.md#migrations)). Migrations are
   not applied by the deploy.
1. Deploy the new version **as a candidate revision without traffic**, and run Check 1, the pre-traffic form of Check 2,
   Check 3 and Check 4 (sign-in) against its URL ([procedure](deployment-gcp.md#verify-before-a-release-gets-traffic)).
2. Move traffic to it.
3. After real traffic (e.g. the next day), run the full Check 2 query
   ([§6](deployment-gcp.md#verify-after-deploying-and-after-any-change-in-front-of-the-api)).

Run the same checks **whenever anything changes in front of the API** (load balancer, CDN, custom domain, Firebase Hosting,
moving off Cloud Run), and update `TRUST_PROXY_HOPS` first
([what to change](deployment-gcp.md#revisit-trust_proxy_hops-whenever-the-path-to-the-api-changes)).

**Lowering a per-minute budget** needs a shadow period again (at least 7 days, see
[deployment-gcp.md](deployment-gcp.md#rolling-out-the-per-minute-limits-shadow--enforce)). **Adding a sign-in method**
follows [auth-providers.md](auth-providers.md#adding-a-method-checklist).

## 3. Regular review (e.g. monthly)

- **Daily totals vs. real use.** Keep `ANON_GLOBAL_DAILY_LIMIT` and `SIGNED_IN_GLOBAL_DAILY_LIMIT` a few times above
  normal daily volume:
  ```sql
  SELECT query_date, identity, count FROM chat_usage
  WHERE identity IN ('global:anon', 'global:signed_in') ORDER BY query_date DESC, identity LIMIT 60;
  ```
- **Sign-ups per sign-in method** (`user_signed_up`, [auth-providers.md](auth-providers.md#5-after-release)), especially
  after adding a method. A spike from one method without matching use is account-creation abuse.
- **How often the per-network limit is hit** (`chat_limit_reached`, `scope="ip"`). Occasional hits are normal: offices,
  campuses, and mobile carriers that put many users behind one IP (carrier-grade NAT), plus people rotating sessions. A steady rise as
  traffic grows means 20/day is getting tight for shared networks. Raise `ANON_IP_DAILY_LIMIT`.
- **The retention job is running:** the oldest raw row is at most 7 days old, and yesterday has a summary.
  ```sql
  SELECT (SELECT MIN(query_date) FROM chat_usage) AS oldest_raw_day,
         (SELECT MAX(query_date) FROM chat_usage_daily) AS latest_summary_day;
  -- expected: oldest_raw_day >= CURRENT_DATE - 7, latest_summary_day = CURRENT_DATE - 1
  ```
- **Check 2 query** (distinct networks vs. sessions). This catches a proxy added without updating `TRUST_PROXY_HOPS`.
- **Per-minute limits** (`rate_limit_summary`, [query](deployment-gcp.md#rolling-out-the-per-minute-limits-shadow--enforce)).
  Occasional lines with one client and a high `max_per_client` are scripts being stopped, which is the point. Lines
  during normal hours with many clients, or a group that's always near its budget, mean a budget is too tight: raise
  that `RATE_LIMIT_*_PER_MIN`.
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

## 4. Analytics on `chat_usage` and `chat_usage_daily`

**History: `chat_usage_daily`.** One row per UTC day and identity type, with counts only. The retention job writes
it for every completed day before old raw rows are deleted:

| `identity_type` | `identities` | `questions` |
|---|---|---|
| `user` | signed-in users who asked | their questions |
| `anon` | anonymous sessions that asked | their questions |
| `ip` | networks the anonymous questions came from (distinct IPs, IPv6 /64s) | **the same anonymous questions again: don't add to `anon`** |

```sql
SELECT query_date, identity_type, identities, questions FROM chat_usage_daily
WHERE identity_type IN ('user', 'anon') ORDER BY query_date DESC, identity_type;
```

**The last 7 days, in detail: `chat_usage`.** It is for enforcing limits, not an event log, and only holds the last
7 days (plus today). One row per identity per UTC day, holding that day's count:

| `identity_type` | Row is | Use for analytics? |
|---|---|---|
| `user` | a signed-in user (Firebase UID) | yes |
| `anon` | an anonymous browser session (`X-Session-ID`) | yes. A session is a browser profile, not a person |
| `ip` | all anonymous sessions from one network (keyed hash) | **no**: counts the same questions again |
| `global` | the day's totals: `global:anon` (all anonymous questions) and `global:signed_in` (all signed-in questions) | **no**: counts the same questions again (though they are quick totals) |

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
| Firebase UID (per day, with that day's question count) | `chat_usage` (`user` rows) | 7 days (retention job) |
| Anonymous session id (a random UUID the browser generates and keeps) | `chat_usage` (`anon` rows) | 7 days (retention job) |
| Visitor IP, **as a keyed hash** of date + IP (IPv6: /64 prefix) | `chat_usage` (`ip` rows) | 7 days (retention job) |
| Daily counts per identity type (no identifiers) | `chat_usage_daily` | indefinitely: aggregated, not personal data |
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
- **Retention:** the counters are only needed for the current day, plus the previous day, because a question near
  midnight is refunded to its own day. The retention job keeps **7 days** (a week of detail for troubleshooting and
  the monthly checks), after saving each day's totals without identifiers (`chat_usage_daily`). State the 7 days in
  the privacy policy. The job must keep running ([§1](#1-one-time-setup), [§3](#3-regular-review-eg-monthly)).
- **Data subject requests:** we can't find a person's `ip` rows without their IP and the dates, and we don't need to
  identify people to run the limits (GDPR Art. 11 covers this case). Deleting a signed-in user should also delete their
  `chat_usage` rows, once account deletion exists.
- **Browser storage (frontend):** the session id kept in the browser (e.g. in `localStorage`) counts as storing
  information on the visitor's device under the ePrivacy rules. It is arguably *strictly necessary* for the chat the visitor uses (so no consent
  needed), but the cookie/storage notice should list it. Have legal confirm.
- **Secrets:** the IP-hash key is derived from `JWT_SECRET`. If that secret leaks, stored IP hashes could be reversed by
  brute force, which is one more reason to treat it as sensitive and rotate it if exposed.

## 6. Constraints to keep in mind

- **Every call the Next.js server makes for a visitor must carry the relay headers** (`X-Relay-Secret`,
  `X-Visitor-IP`), on every endpoint ([api.md](api.md#calls-from-a-server-on-a-visitors-behalf)). A call without them
  counts as the server's own IP, shared by all visitors. `X-Visitor-IP` must be the last `X-Forwarded-For` entry the
  Next.js server received on Cloud Run, never the first. The secret must never reach browser code.
- **The relay secret is sensitive:** whoever has it can get around every per-visitor limit. Rotate it if it may have
  leaked, and otherwise about once a year ([procedure](deployment-gcp.md#trusted-relay-the-nextjs-server)).
- **Anything added in front of the API** changes how visitor IPs are worked out (§2 above).
- **`X-Session-ID` must stay stable per browser** ([api.md](api.md#requirements-for-clients), requirement 2). A client
  that makes a new one per visit or per limit hit only moves its users on to the per-network limit (20 a day) and adds
  rows to `chat_usage`. The per-session limit of 5 then means nothing.

## 7. What can be tested before deploying

| What | `npm test` | Local simulation¹ | Candidate revision (no traffic) | Live traffic |
|---|---|---|---|---|
| Limit logic, messages, `Retry-After`, input limits, settings validation | ✓ | ✓ | ✓ | |
| IP parsing, hop counting, IPv6 grouping, faked entries ignored | ✓ (unit) | ✓ (through a proxy) | ✓ (Check 1) | |
| Exact limits under concurrency on **real Postgres** (connection pool, row locks, no deadlocks) | partly (PGlite has one connection) | ✓ | | |
| **Cloud Run's front end really appends the visitor IP last** (the main assumption) | | | ✓ (Check 1) | |
| Visitors on different networks get different counters (hops not too low) | | | ✓ (two-network check) | ✓ (Check 2) |
| Per-minute limits: budgets, route groups, `429` contract, shadow mode, summary log, memory bound | ✓ | ✓ | ✓ (Check 3) | |
| Trusted relay: secret checks, rotation with two secrets, visitor IP rules, fallback to the relay's IP, `relay_auth_failed` | ✓ | ✓ | | |
| The frontend sends the relay headers correctly (right secret, last `X-Forwarded-For` entry) | | | | ✓ (Check 5) |
| `proxy_hops_mismatch` detection | ✓ | ✓ | | ✓ (absence of the warning) |
| Per-minute budgets fit real traffic; the Next.js server sends the relay headers on every call | | | | ✓ (shadow mode, Check 5) |
| Logs appear in Cloud Logging with `severity` and `jsonPayload.event` | | | ✓ (the 21st request of Check 1 logs `chat_limit_reached`) | |
| Real Gemini / Vertex behaviour | | | ✓ | ✓ |

¹ Not part of the repo yet. For Step 2 the built app was run against a real Postgres 16, behind a small proxy that adds
`X-Forwarded-For` like Cloud Run's front end, with Gemini stubbed. Making that a repeatable `npm run test:e2e` is
a possible follow-up.
