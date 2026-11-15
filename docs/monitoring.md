# Monitoring, alerts and spending brakes (Google Cloud)

What to set up to know when the API is down, under attack, misconfigured or spending too much. It covers where to set up
each item, how, and what it costs. Free options come first, and each paid
option says what it buys.

Scope: the API (Cloud Run service), its database (Cloud SQL) and the AI services it calls (Vertex AI: Gemini and text
embeddings). The batch jobs share the same project and budget. Related: [operations.md](operations.md) (the routine),
[deployment-gcp.md §6](deployment-gcp.md#6-client-ip-and-abuse-limits) (abuse limits, checks, emergency switches).

> **About the prices.** Figures are Google Cloud list prices as known when this was written, not read from your
> billing account. They change, so check the pricing pages linked in [Costs](#costs-and-free-tiers) before relying on
> one. Every recommendation here stays inside a free tier at CourseCorrect's current size, except alert conditions
> (a few dollars a month at most).
>
> **About the commands.** The Console steps are the reliable route. The `gcloud` commands and YAML were written without
> access to your project: if a flag is rejected by your `gcloud` version, use the Console steps instead.

## At a glance

**Do now.** All free, except two alert conditions:

| # | What | Catches | Cost / month |
|---|---|---|---|
| 1 | [Notification channels](#1-notification-channels): email + Google Cloud mobile app | (delivers everything below) | $0 |
| 2 | [Billing budget for the project](#2-billing-budgets) with threshold alerts | spending more than planned, from any cause | $0 |
| 3 | [Billing budget for Vertex AI only](#2-billing-budgets) | AI spend in particular (chat, embeddings, insights job) | $0 |
| 4 | [Quota cap on the embedding model](#3-quota-caps-the-only-real-spending-brake) | runaway embedding calls: a **hard stop**, not just an alert | $0 |
| 5 | [Uptime check on `/health`](#4-uptime-check) + alert | API or database down | $0 checks + 1 alert condition |
| 6 | [One log alert for abuse and configuration signals](#5-one-log-alert-for-abuse-and-configuration-signals) | chat switched off by a daily total, a flood, visitors' IPs not seen or faked | 1 alert condition |
| 7 | [Error Reporting notifications](#6-error-reporting) | new kinds of server errors | $0 |

**Optional.** One alert condition each (see the [trade-offs](#7-optional-metric-alerts)):

| # | What | Catches |
|---|---|---|
| 8 | Cloud Run at its instance ceiling for 15 minutes | overload: a flood, or a slow database making requests pile up |
| 9 | Cloud Run 5xx responses | server errors visitors see |
| 10 | Cloud SQL CPU above 80% for 15 minutes | the database is the bottleneck (e.g. heavy search traffic) |

**Free, no alerts:** [dashboards and a monthly review](#8-dashboards-and-the-monthly-review) (built-in Cloud Run and
Cloud SQL pages, Billing reports by SKU, one log-based metric, Log Analytics queries).

**Not now** (cost more than they're worth at this size): Cloud Armor (about $25/month before traffic, needs a load
balancer), Redis/Memorystore, paid paging services, longer log retention. See [Not now](#not-now).

Estimated total: **$0 plus up to about $3/month** for the two alert conditions (up to about $7.50/month with
all three optional alerts), as long as logs stay within the free 50 GiB/month (they're far below it).

## Variables

The commands below use these, as in [deployment-gcp.md](deployment-gcp.md#0-variables):

```sh
export PROJECT_ID=my-project
export REGION=us-central1
export SERVICE=cc-backend-v1-5                       # the Cloud Run service (_SERVICE in cloudbuild.api.yaml)
export API_HOST=cc-backend-v1-5-xxxxxxxx-uc.a.run.app   # host the frontend calls (no https://)
export BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX          # gcloud billing accounts list
```

## 1. Notification channels

Where alerts are delivered. Set up once and reuse them for every alert below.

- **Email:** free. **Google Cloud mobile app** (iOS/Android push notifications): free, and you notice it sooner than an email.
  Avoid SMS and paid paging services for now.
- *Console:* Monitoring → Alerting → **Edit notification channels** → Email → Add new. For the app: install "Google
  Cloud" on your phone and sign in; it appears as a **Cloud Mobile App** channel.
- *gcloud:*
  ```sh
  gcloud beta monitoring channels create --project=$PROJECT_ID \
    --display-name="Ops email" --type=email --channel-labels=email_address=you@example.com
  gcloud beta monitoring channels list --project=$PROJECT_ID --format='value(name, displayName)'   # IDs for the YAML below
  ```

## 2. Billing budgets

A budget **only notifies**: it doesn't stop spending (that's [quotas](#3-quota-caps-the-only-real-spending-brake) and the
in-app limits). Billing data can lag by several hours, so a budget alert is a "this month is going wrong" signal, not
a real-time one. Budgets are free.

Create two:

| Budget | Scope | Amount | Alert at |
|---|---|---|---|
| Project | the API's project, all services | your normal monthly total + about 20% | 50%, 90%, 100% of actual spend, and 100% of **forecasted** spend |
| AI | same project, service **Vertex AI** only | your normal Vertex AI spend + about 50% (AI spend is the part abuse moves) | same |

The forecast alert is the useful early warning: it fires mid-month when the trend will exceed the budget.

- *Console:* Billing → **Budgets & alerts** → Create budget → Scope: select the project (and for the second budget, under
  Services, **Vertex AI**) → Amount → Thresholds as above → under Notifications, also connect the email channel from §1
  ("Link Monitoring email notification channels"), so the alerts aren't only sent to billing admins.
- *gcloud* (project budget; the Vertex AI filter is easiest to pick in the Console):
  ```sh
  BUDGET_USD=...   # your normal monthly total + about 20% (table above)
  gcloud billing budgets create --billing-account=$BILLING_ACCOUNT \
    --display-name="coursecorrect: project" --budget-amount=${BUDGET_USD}USD \
    --filter-projects=projects/$PROJECT_ID \
    --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
    --threshold-rule=percent=1.0,basis=forecasted-spend
  ```
- Also worth a look: Billing → **Reports** (group by *SKU* to see exactly what costs money, e.g. Gemini input vs output
  tokens) and, if your billing account shows it, **Anomalies** (automatic cost-anomaly detection, free).

*Not recommended:* wiring a budget to a function that **disables billing** for the project. It stops everything,
including the website, and re-enabling isn't instant. The in-app limits and quotas below are the right brakes.

## 3. Quota caps: the only real spending brake

Quotas are enforced by Google, so unlike budgets they actually stop calls. Lowering a quota is free and applies
without approval.

**Text embeddings (do this).** Every search and every chat question makes one embedding call, and so does the embedding
job (100 texts per call). If the quota is hit, search falls back to keyword-only and chat answers without catalogue
retrieval. Both keep working, so a cap causes **degradation, not an outage**: a safe brake.

- *Console:* IAM & Admin → **Quotas & System Limits** → filter *Service: Vertex AI API* and search for **online
  prediction requests per base model per minute**. Pick the row for region `us-central1` and base model
  `text-embedding-004` → Edit → lower the value.
- *Value:* the same page shows current and peak usage. Set the cap to about 3–5× your normal peak, e.g. **300 per
  minute**. That still allows every visitor's searches, but caps a worst-case month at roughly 13M calls (about $65 at
  200 characters each). Raise it before a large embedding job run if the job gets slow.

**Gemini 2.5 Flash (check).** Look on the same page for a Gemini 2.5 Flash request quota you can lower. Gemini 2.x models
on Vertex AI use *dynamic shared quota*, so there may be **no per-project limit to lower**. If there isn't one, the
brakes for chat are:
- the in-app daily totals: anonymous questions are capped by `ANON_GLOBAL_DAILY_LIMIT` and signed-in questions by
  `SIGNED_IN_GLOBAL_DAILY_LIMIT` (1,000/day each by default, about $20/day each in the worst case, when every question
  is as large as the input limits allow);
- the emergency switches in [deployment-gcp.md §6](deployment-gcp.md#changing-limits-and-emergency-switches).
  **`CHAT_MODE=off`** (or `signed_in_only`) stops chat within about a minute, without a build. **Careful:** setting a
  daily limit to `0` means *no limit*, not "off".

## 4. Uptime check

Checks from outside Google's network that the API answers, every 5 minutes, from 3 regions. `GET /health` runs
`SELECT 1`, so it also fails when the database is down (`503`).

- *Cost:* about 26,000 checks a month, within the free allowance (1 million a month). The API caches the database
  check for 5 seconds, so checks from several regions at once cost one database query. The requests are tiny and stay within
  Cloud Run's free tier. The alert is 1 condition.
- *Console:* Monitoring → **Uptime checks** → Create → Protocol HTTPS, Resource type URL, Hostname `$API_HOST`, Path
  `/health`, Check frequency **5 minutes**, Regions: 3 (e.g. the USA ones) → Response validation: status 2xx, Timeout
  **10 s** (a cold start takes a few seconds, because the service scales to zero) → **Create alert**: the Console offers it in
  the same flow. Pick the §1 channels, and alert when the check fails from **2 or more** regions for 5 minutes (a
  single region failing is usually a network blip).
- *gcloud* (then add the alert in the Console):
  ```sh
  gcloud monitoring uptime create cc-api-health --project=$PROJECT_ID \
    --resource-type=uptime-url --resource-labels=host=$API_HOST,project_id=$PROJECT_ID \
    --protocol=https --path=/health --period=5 --timeout=10
  ```

## 5. One log alert for abuse and configuration signals

The API and the retention job write structured log events ([reference](#log-events-reference)). Six of them need a person. Instead of one
alert each (one condition each), **one log-match alert covers all of them** and says which one fired:

| Event | Fires when | What to do |
|---|---|---|
| `chat_limit_reached` with `scope: "global"` or `"signed_in_global"` | anonymous (or signed-in) chat has hit its daily total: it's off for that whole group until midnight UTC | heavy use or an attack (for signed-in: accounts being created in bulk, see `user_signed_up`). Check [deployment-gcp.md §6 Monitoring](deployment-gcp.md#monitoring). Raise `ANON_GLOBAL_DAILY_LIMIT` / `SIGNED_IN_GLOBAL_DAILY_LIMIT` if it's real use |
| `client_ip_unknown` | the API can't see visitor IPs, so per-IP limits are skipped | never expected on Cloud Run. Check what changed in front of the API |
| `proxy_hops_mismatch` | `TRUST_PROXY_HOPS` doesn't match the traffic: visitors share one IP, or can fake theirs | [what a wrong setting does](deployment-gcp.md#what-a-wrong-trust_proxy_hops-does) |
| `relay_auth_failed` | calls from the Next.js server came with a wrong secret or a missing, invalid or private visitor IP: those visitors are counted together as the server's IP (once enforced: `429`s on server-rendered pages) | usually a secret rotated on one side only, or a frontend change. [What can go wrong](deployment-gcp.md#trusted-relay-the-nextjs-server) |
| `chat_usage_retention_failed` (from the Cloud Run **job**) | the daily retention run failed: old `chat_usage` rows (personal data) aren't being deleted | look at the error in the same log entry. Rerun with `gcloud run jobs execute chat-usage-retention` once fixed |
| `rate_limit_summary` with `over_limit` ≥ 300 | at least 300 requests in one minute on one instance were over a per-minute limit: a flood | look at `by_group`, `clients` and `max_per_client`. One client means a script. Many clients means a distributed attack ([Not now: Cloud Armor](#not-now)) |

- *Cost:* 1 alert condition. The notification rate limit (below) keeps a flood from sending hundreds of emails.
- *Console:* Logging → **Logs Explorer** → paste the filter below → **Actions → Create log alert** → name it →
  "Time between notifications" **1 hour** → pick the §1 channels.
- *Filter:*
  ```
  (
    resource.type="cloud_run_revision"
    (
      jsonPayload.event="proxy_hops_mismatch"
      OR jsonPayload.event="client_ip_unknown"
      OR jsonPayload.event="relay_auth_failed"
      OR (jsonPayload.event="chat_limit_reached" AND jsonPayload.scope=("global" OR "signed_in_global"))
      OR (jsonPayload.event="rate_limit_summary" AND jsonPayload.over_limit>=300)
    )
  )
  OR (resource.type="cloud_run_job" AND jsonPayload.event="chat_usage_retention_failed")
  ```
- *gcloud:* save as `abuse-alert.yaml` (replace `CHANNEL_ID` with an ID from §1), then
  `gcloud alpha monitoring policies create --project=$PROJECT_ID --policy-from-file=abuse-alert.yaml`:
  ```yaml
  displayName: "API: abuse or configuration signal"
  combiner: OR
  conditions:
    - displayName: "abuse/config log event"
      conditionMatchedLog:
        filter: >-
          (resource.type="cloud_run_revision"
          (jsonPayload.event="proxy_hops_mismatch"
          OR jsonPayload.event="client_ip_unknown"
          OR jsonPayload.event="relay_auth_failed"
          OR (jsonPayload.event="chat_limit_reached" AND jsonPayload.scope=("global" OR "signed_in_global"))
          OR (jsonPayload.event="rate_limit_summary" AND jsonPayload.over_limit>=300)))
          OR (resource.type="cloud_run_job" AND jsonPayload.event="chat_usage_retention_failed")
        labelExtractors:
          event: EXTRACT(jsonPayload.event)
  alertStrategy:
    notificationRateLimit:
      period: 3600s
    autoClose: 1800s
  documentation:
    mimeType: text/markdown
    content: "Event **${log.extracted_label.event}**. What to do: docs/monitoring.md §5."
  notificationChannels:
    - projects/PROJECT_ID/notificationChannels/CHANNEL_ID
  ```
- *Tune:* if `rate_limit_summary` alerts come from harmless crawlers, raise 300. While the per-minute limits are still in
  **shadow mode**, the same events tell you that enforcing would have rejected a flood.

## 6. Error Reporting

Groups server errors by type and can email you the first time a new kind appears. Free.

- *Console:* **Error Reporting** → (top of the page) **Configure notifications** → pick the §1 channels.
- Every error the API logs is **one structured line** with severity `ERROR`, the stack trace in `message`, an `event`
  saying where it happened, and the type marker Error Reporting looks for (`src/lib/logger.ts`, `logError`). Anything a
  route doesn't handle is logged as `unhandled_error` with the route pattern (no ids, no query strings) and answered
  with a JSON `500`. So Error Reporting groups every error without extra setup.
- Expected, handled failures are errors too (e.g. `chat_rag_failed` when the embedding API is down: chat still
  answers). They're worth knowing about, and Error Reporting notifies only on the *first* occurrence of each kind.

## 7. Optional metric alerts

These use free Google Cloud metrics. Each costs 1 alert condition. They answer "is it overloaded?" and "are visitors
getting errors?", which the uptime check alone doesn't.

| # | Alert | Metric | Condition | Why it's optional |
|---|---|---|---|---|
| 8 | Cloud Run at its ceiling | Cloud Run Revision → *Instance count* (`run.googleapis.com/container/instance_count`), filter `service_name=$SERVICE` | max ≥ `_MAX_INSTANCES` (3) for 15 minutes | Most useful single overload signal: a flood or a slow database both end here. Without it you'd notice through the uptime check (only when it's bad enough to fail) |
| 9 | 5xx responses | Cloud Run Revision → *Request count* (`run.googleapis.com/request_count`), filter `response_code_class="5xx"` | sum > 10 in 5 minutes | Error Reporting notifies on new *kinds* of errors; this one catches a *rate* of them (e.g. the database failing). Chat generation errors are streamed inside a `200`, so they don't count here |
| 10 | Database CPU | Cloud SQL Database → *CPU utilization* (`cloudsql.googleapis.com/database/cpu/utilization`) | > 0.8 for 15 minutes | Search is the heaviest query. The per-minute limits make this less likely |

*Console:* Monitoring → Alerting → **Create policy** → Select a metric (names above) → add the filter → Threshold →
the §1 channels.

*Instead of a disk-space alert:* turn on **automatic storage increase** for the Cloud SQL instance (Cloud SQL →
instance → Edit → Storage), with a limit. You then pay only for the storage actually used, and the disk never fills up.

## 8. Dashboards and the monthly review

Free, and enough at this size. Use alerts only for things that need someone right away.

**Built-in pages (nothing to set up):**
- Cloud Run → service → **Metrics**: requests by response code, latency, instances, CPU/memory, billable instance time.
- Cloud SQL → instance → **Overview** (CPU, memory, connections, storage) and **Query insights** (slowest queries).
- Vertex AI API: APIs & Services → Vertex AI API → **Metrics** (traffic and errors by method).
- Billing → **Reports**, grouped by SKU: the real cost of Gemini tokens, embeddings, Cloud Run, Cloud SQL, logging.

**One log-based metric (optional, about $0):** answers by outcome, for a chart of completed, truncated, timed-out and
failed answers. It's tiny, far below the 150 MiB/month of free metric data.

```sh
cat > chat-answers-metric.yaml <<'EOF'
description: Chat answers by outcome (jsonPayload.event="chat_answer")
filter: resource.type="cloud_run_revision" AND jsonPayload.event="chat_answer"
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: outcome
      valueType: STRING
labelExtractors:
  outcome: EXTRACT(jsonPayload.outcome)
EOF
gcloud logging metrics create chat_answers --project=$PROJECT_ID --config-from-file=chat-answers-metric.yaml
```
Then Monitoring → **Dashboards** → Create → add a chart for `logging/user/chat_answers`, grouped by `outcome`. Add the
Cloud Run and Cloud SQL charts from §7 to the same dashboard: dashboards are free.

**Log Analytics for the monthly numbers (free):** Logging → Logs Storage → `_Default` bucket → **Upgrade to use Log
Analytics** (no extra charge for queries run in the Console; the upgrade can't be undone, which is harmless here). Then run SQL
over the logs, e.g. answer outcomes and token use for the last 30 days (feeds the review in
[operations.md §3](operations.md#3-regular-review-eg-monthly)):

```sql
SELECT
  JSON_VALUE(json_payload.outcome) AS outcome,
  COUNT(*) AS answers,
  SUM(CAST(JSON_VALUE(json_payload.prompt_tokens) AS INT64))   AS prompt_tokens,
  SUM(CAST(JSON_VALUE(json_payload.thinking_tokens) AS INT64)) AS thinking_tokens,
  SUM(CAST(JSON_VALUE(json_payload.answer_tokens) AS INT64))   AS answer_tokens
FROM `PROJECT_ID.global._Default._AllLogs`
WHERE JSON_VALUE(json_payload.event) = 'chat_answer'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY outcome
ORDER BY answers DESC
```

The same works for `rate_limit_summary` (how often each group throttles) and `auth_rejected` (bad tokens by reason).

## Costs and free tiers

| Item | Price | Free | Our usage |
|---|---|---|---|
| [Cloud Logging](https://cloud.google.com/stackdriver/pricing) ingestion | $0.50/GiB | 50 GiB per project per month; 30 days of retention included | far below: one request log line per request plus a few app events |
| [Cloud Monitoring](https://cloud.google.com/stackdriver/pricing) Google Cloud metrics (Cloud Run, Cloud SQL, Vertex AI) | free | — | — |
| Log-based metrics | about $0.26/MiB of metric data | 150 MiB per billing account per month | a few MiB at most |
| Uptime checks | about $0.30 per 1,000 executions | 1 million executions per month | about 26,000 |
| Alerting policies | Google has announced a monthly price **per condition** (up to about $1.50) plus $0.35 per million time series scanned. Check the page for the current figure and start date | — | 2 conditions (up to 5 with the optional ones) |
| Dashboards, notification channels (email, mobile app), Error Reporting, budgets, quota changes, Log Analytics queries in the Console | free | — | — |

**Keeping logging free under a flood.** Every request, including rejected ones, creates a Cloud Run request log entry
(about 1 KB). 50 GiB is roughly 50 million requests a month, so only a sustained flood gets close. If Logging → **Logs
Storage** ever shows the month heading past 50 GiB, add an **exclusion** that drops most rate-limited request logs.
Excluded logs aren't stored, and you don't pay for them. The API's once-a-minute `rate_limit_summary` still reports the
flood.
- *Console:* Logging → **Log Router** → `_Default` sink → Edit → Add exclusion, with the filter
  `resource.type="cloud_run_revision" AND httpRequest.status=429 AND sample(insertId, 0.99)` (drops 99% of them).

Don't raise the `_Default` bucket's retention above 30 days (longer retention is billed, and these logs contain
visitor IPs, see [operations.md §5](operations.md#5-privacy-and-compliance)).

## Not now

| Option | What it adds | Approximate cost | When to revisit |
|---|---|---|---|
| Cloud Armor (needs an external Application Load Balancer) | per-IP limits across all instances at Google's edge, bot/DDoS rules | about $18/month for the load balancer + $5/policy + $1/rule + $0.75 per million requests | a distributed attack the per-instance limits can't contain. Putting a load balancer in front also changes `TRUST_PROXY_HOPS` ([§6](deployment-gcp.md#revisit-trust_proxy_hops-whenever-the-path-to-the-api-changes)) |
| Memorystore (Redis) for exact shared rate-limit counts | one count per client across instances | about $35/month minimum | several instances routinely running and the limits being bypassed in practice |
| Paid on-call paging (PagerDuty, Opsgenie) | escalation, phone calls | per user per month | when someone is on call |
| Logs kept longer than 30 days | history | $0.01/GiB/month | a compliance need (and check privacy first) |
| Billing-disable "kill switch" function | hard stop at a budget | free to run | not recommended: it takes the whole site down. If you ever want an automatic brake, have the budget's Pub/Sub notification trigger a small function that sets `CHAT_MODE=off` instead: it stops only the paid chat |

## Log events reference

### How the once-a-minute summary lines work

`rate_limit_summary`, `relay_auth_failed`, `proxy_hops_mismatch` and the rate limiter's `client_ip_unknown` aren't
written per request, so a flood can't run up the logging bill. Per instance:

1. The first occurrence opens a window (its start is logged as `window_start`).
2. Every occurrence after that is **counted**; none are skipped.
3. Every request, of any kind, first checks whether a window has been open for a minute. If so, that request writes the
   line with all the counts and closes the window. There's no timer: on Cloud Run an instance gets little or no CPU
   between requests, so a timer wouldn't fire reliably.

What that means in practice:
- **Counts are complete while traffic flows.** Each instance writes its own lines (with 3 instances, add them up).
- **A window can be reported late:** if traffic stops, the line is written by the next request, whenever it comes,
  and the window covers more than a minute.
- **The last window can be lost:** if the instance shuts down (scale to zero, a deploy) before another request
  arrives, its open window is never written.

Both only affect a few occurrences just before a quiet period. The problems these lines exist for (a flood, a
misconfigured relay or proxy) produce a steady stream, so the lines, and the alert, keep coming. If the tail ever
matters, a shutdown handler could write open windows: Cloud Run sends `SIGTERM` about 10 seconds before stopping an
instance, so there would be time. That's not built, since it isn't worth it today. Cloud Run's own request logs
record every request, for an exact reconstruction.

Every event the API writes as a structured log (`jsonPayload.event`). Query them with
`jsonPayload.event="<name>"` in the Logs Explorer.

| Event | Severity | Written | Alert? | Details |
|---|---|---|---|---|
| `chat_limit_reached` | WARNING | per question refused by a shared daily limit: `ip`, `global` (anonymous total) or `signed_in_global` | totals: yes (§5). `ip`: review monthly | [deployment-gcp.md §6](deployment-gcp.md#monitoring) |
| `client_ip_unknown` | WARNING | per chat question, or once a minute per instance from the rate limiter | yes (§5) | same |
| `proxy_hops_mismatch` | WARNING | once a minute per instance at most | yes (§5) | [§6](deployment-gcp.md#what-a-wrong-trust_proxy_hops-does) |
| `relay_auth_failed` | WARNING | once a minute per instance at most, with counts per problem | yes (§5) | [§6](deployment-gcp.md#trusted-relay-the-nextjs-server) |
| `rate_limit_summary` | WARNING | once a minute per instance, when something went over a per-minute limit | floods only (§5) | [§6](deployment-gcp.md#rolling-out-the-per-minute-limits-shadow--enforce) |
| `chat_answer` | INFO | per answered question: outcome, duration, tokens | no: dashboard and monthly review (§8) | [operations.md §3a](operations.md#3a-chat-answer-logs) |
| `auth_rejected` | INFO | per request with a bad token on `/saved` | no | reason = JWT error name, e.g. `JwtTokenExpired` |
| `login_rejected` | INFO | per login refused by the sign-in rules | no | `reason` (`provider_not_allowed`, `email_not_verified`) and `provider`. Many for Google users after a release means `AUTH_ALLOWED_PROVIDERS` is wrong. [auth-providers.md](auth-providers.md) |
| `chat_usage_retention` | INFO | once per daily retention run | no (a missing run shows in the monthly check, [operations.md §3](operations.md#3-regular-review-eg-monthly)) | `summary_rows`, `deleted_rows`, `retention_days` |
| `user_signed_up` | INFO | per new account | no: weekly look after adding a sign-in method | `provider`. No identity. A spike from one method is account-creation abuse |

**Errors** (severity `ERROR`, picked up by [Error Reporting](#6-error-reporting); each has the stack trace in `message`):

| Event | Written when |
|---|---|
| `unhandled_error` | a route failed unexpectedly (the client got `500`). With `method` and `route` (the pattern) |
| `health_check_failed` | `/health` couldn't reach the database, or it didn't answer within 3 s (`DatabaseCheckTimeout`). At most one per instance every 5 s, since the result is cached |
| `subjects_refresh_failed` | the 10-minute refresh of the taxonomy failed; the previous copy is still served, and the refresh is retried after 30 s |
| `chat_generation_failed` | Gemini failed or timed out during an answer. With `outcome` (`error` or `timeout`) |
| `chat_rag_failed` | catalogue retrieval (embedding) failed; the answer continued without it |
| `chat_usage_retention_failed` | the retention job failed (from the Cloud Run job, which then exits with an error). Also in the §5 alert |
| `search_embedding_failed` | the search query couldn't be embedded in time (5 s) or at all; the search answered with keyword ranking only (`vector_search: false`) |
| `chat_refund_failed` | giving back an unanswered question failed (the user lost one question) |

And `chat_mode` (WARNING), once per instance start when `CHAT_MODE` isn't `on`, so you can see the switch took effect.
