# Deploying to Google Cloud

This guide deploys the API as a Cloud Run service and the batch jobs as Cloud Run Jobs, backed by Cloud SQL for PostgreSQL and Vertex AI. The API and the jobs use the same container image.

## 0. Variables

Every command below uses these shell variables. Set them once per terminal session:

```sh
export PROJECT_ID=my-project
export REGION=us-central1
export SQL_INSTANCE=my-postgres                      # Cloud SQL instance name
export SQL_CONNECTION=$PROJECT_ID:$REGION:$SQL_INSTANCE
export AR_REPO=coursecorrect                         # Artifact Registry repository
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/cc-backend:latest
export JOBS_SA=batch-jobs@$PROJECT_ID.iam.gserviceaccount.com
```

## 1. One-time setup

```sh
gcloud services enable run.googleapis.com sqladmin.googleapis.com aiplatform.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com \
  --project=$PROJECT_ID

gcloud artifacts repositories create $AR_REPO \
  --repository-format=docker --location=$REGION --project=$PROJECT_ID

# Service account for the jobs: Cloud SQL, Vertex AI and Secret Manager access
gcloud iam service-accounts create batch-jobs --project=$PROJECT_ID
for role in roles/cloudsql.client roles/aiplatform.user roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$JOBS_SA" --role=$role
done
```

### Database

Create a PostgreSQL instance with the `vector` extension available (Cloud SQL supports pgvector), a database and an application user. The application user needs to be able to create objects in the `public` schema:

```sql
GRANT CREATE ON SCHEMA public TO <app_user>;
GRANT USAGE ON SCHEMA public TO <app_user>;
```

Apply migrations from a machine that can reach the database (for example through [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy)):

```sh
cloud-sql-proxy "$SQL_CONNECTION" --port=5432 &
DATABASE_URL=postgresql://<app_user>:<password>@localhost:5432/<db> npx drizzle-kit migrate
```

On Cloud Run, `DATABASE_URL` must use the Unix socket form:

```
postgresql://<app_user>:<password>@/<db>?host=/cloudsql/<SQL_CONNECTION>
```

### Secrets

Store secrets in Secret Manager. These names match the `_SECRETS` default in `cloudbuild.api.yaml`:

```sh
printf '%s' "postgresql://..."            | gcloud secrets create database-url   --data-file=- --project=$PROJECT_ID
openssl rand -base64 48 | tr -d '\n'      | gcloud secrets create jwt-secret     --data-file=- --project=$PROJECT_ID
printf '%s' "YOUR_GEMINI_API_KEY_HERE"    | gcloud secrets create gemini-api-key --data-file=- --project=$PROJECT_ID  # only for INSIGHTS_PROVIDER=gemini
printf '%s' "YOUR_GROQ_API_KEY_HERE"      | gcloud secrets create groq-api-key   --data-file=- --project=$PROJECT_ID  # only for INSIGHTS_PROVIDER=groq
```

Rotate a secret with `gcloud secrets versions add <name> --data-file=-`.

## 2. API service

`cloudbuild.api.yaml` builds the `Dockerfile`, pushes the image and deploys the API:

```sh
gcloud builds submit --config cloudbuild.api.yaml --project=$PROJECT_ID \
  --substitutions=_TAG=$(git rev-parse --short HEAD),_REGION=$REGION,_REPO=$AR_REPO,_SERVICE=cc-backend,_ALLOWED_ORIGINS=https://example.com
```

Substitutions and their defaults are listed at the bottom of the file; override `_SECRETS` if your secret names differ.
`_MAX_INSTANCES` (default 3) caps the number of API instances. Each instance opens up to 10 database connections, so keep
`_MAX_INSTANCES × 10` (plus the jobs' connections) below the database's connection limit.
The abuse-limit substitutions (`_TRUST_PROXY_HOPS`, `_ANON_IP_DAILY_LIMIT`, `_ANON_GLOBAL_DAILY_LIMIT`) are explained in
[6. Client IP and abuse limits](#6-client-ip-and-abuse-limits). **Read that section before putting anything (load
balancer, CDN, proxy) in front of the API, or moving the API off Cloud Run.** The Cloud Run service also needs the Cloud SQL connection attached once:

```sh
gcloud run services update cc-backend --add-cloudsql-instances=$SQL_CONNECTION --region=$REGION --project=$PROJECT_ID
```

## 3. Batch jobs

The jobs run from the same image as the API; the entry point is chosen per job with `--command` / `--args`.

| Job | `--args` | Suggested resources | Env vars |
|---|---|---|---|
| `embedder` | `dist/jobs/embed.js` | 1 CPU / 1Gi, 24h timeout | optional `PROVIDER` |
| `insights-batch` | `dist/jobs/insights/batch.js` | 1 CPU / 1Gi, 6h timeout, `--max-retries=0` | `INSIGHTS_PROVIDER`, `TOP_N`, `CONCURRENCY`, `BATCH_DELAY_MS` |

Create a job (once):

```sh
gcloud run jobs create embedder \
  --image=$IMAGE --region=$REGION --project=$PROJECT_ID \
  --service-account=$JOBS_SA \
  --set-cloudsql-instances=$SQL_CONNECTION \
  --set-secrets=DATABASE_URL=database-url:latest \
  --set-env-vars=GOOGLE_CLOUD_PROJECT=$PROJECT_ID \
  --command=node --args=dist/jobs/embed.js \
  --cpu=1 --memory=1Gi --task-timeout=24h --max-retries=1
```

After deploying a new image, update each job with `gcloud run jobs update <job> --image=$IMAGE --region=$REGION --project=$PROJECT_ID`.

Run a job, or validate a new deploy with a capped dry run:

```sh
gcloud run jobs execute embedder --region=$REGION --project=$PROJECT_ID
gcloud run jobs execute embedder --region=$REGION --project=$PROJECT_ID --update-env-vars=DRY_RUN_LIMIT=20
```

- **`embedder`** fills `learning_resources.embedding` for rows where it is `NULL`, then exits. Run it after new resources are added.
- **`insights-batch`** generates `ai_insights` for the top-ranked resources (`rating × ln(num_ratings + 1)`) that don't have them yet.

### Insights providers

| `INSIGHTS_PROVIDER` | Model | Auth | Notes |
|---|---|---|---|
| `vertexai` (default) | Gemini 2.5 Flash on Vertex AI | service account | Paid; supports high concurrency (e.g. `CONCURRENCY=30`, `BATCH_DELAY_MS=0`). |
| `groq` | `llama-3.1-8b-instant` | `GROQ_API_KEY` | Free tier limited by tokens per day; use `CONCURRENCY=1` and a small `TOP_N`. |
| `gemini` | `gemini-2.5-flash-lite` (AI Studio) | `GEMINI_API_KEY` | Free tier allows only a few requests per day. |

The batch exits with `exit_reason` `completed`, `quota_exhausted` (daily quota hit; the next run continues where it stopped) or `too_many_errors` (`MAX_CONSECUTIVE_ERRORS` failures in a row).

### Scheduling

To run a job daily with Cloud Scheduler:

```sh
SA="$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role=roles/run.invoker

gcloud scheduler jobs create http insights-batch-daily \
  --schedule="0 6 * * *" --time-zone=UTC --location=$REGION --project=$PROJECT_ID \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/insights-batch:run" \
  --http-method=POST --message-body='{}' --oauth-service-account-email="$SA"
```

Use `gcloud scheduler jobs pause|resume|delete insights-batch-daily --location=$REGION` to manage it.

## 4. Monitoring

Jobs log structured JSON; Cloud Logging indexes the `event` field.

```sh
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="insights-batch"' \
  --project=$PROJECT_ID --freshness=26h --order=asc \
  --format='value(jsonPayload.event, jsonPayload.processed, jsonPayload.total, jsonPayload.error)'
```

Progress in the database:

```sql
SELECT COUNT(*) FILTER (WHERE embedding IS NULL)   AS pending_embedding,
       COUNT(*) FILTER (WHERE ai_insights IS NULL) AS pending_insights
FROM learning_resources WHERE is_active = true;
```

## 5. Re-processing

```sql
-- Re-embed (required whenever the embedding input format or model changes)
UPDATE learning_resources SET embedding = NULL;

-- Regenerate insights (e.g. after prompt changes)
UPDATE learning_resources SET ai_insights = NULL, ai_insights_updated_at = NULL;
```

Documents are embedded from `{title} | {provider_type} | {institution} | {level} | {skills} | {ai_summary}` with task type `RETRIEVAL_DOCUMENT`; search queries use `RETRIEVAL_QUERY` through `embedQuery()`. Change both sides together and re-embed.

## 6. Client IP and abuse limits

The API limits anonymous chat questions per visitor IP, so that making up new `X-Session-ID`s doesn't give unlimited
free questions. This only works if the API identifies the visitor's IP correctly, and that depends on what sits in
front of it. The code is in `src/lib/client-ip.ts` and `src/api/chat-usage.ts`. The client-facing contract is in
[api.md](api.md#post-apiv1chat-browser-only), and the short list of what to do per release and what to monitor is in
[operations.md](operations.md).

### Settings

| Env var (Cloud Build substitution) | Default | Meaning |
|---|---|---|
| `TRUST_PROXY_HOPS` (`_TRUST_PROXY_HOPS`) | `1` | Number of proxies between the internet and the app. **`1` = Cloud Run reached directly**, which is our setup |
| `ANON_IP_DAILY_LIMIT` (`_ANON_IP_DAILY_LIMIT`) | `20` | Anonymous questions per visitor IP (IPv6: per /64) per UTC day, across all sessions. `0` = off |
| `ANON_GLOBAL_DAILY_LIMIT` (`_ANON_GLOBAL_DAILY_LIMIT`) | `1000` | Anonymous questions per UTC day from all visitors together: a hard ceiling on anonymous chat cost. `0` = off |

Fixed in code: 5 questions per anonymous session and 10 per signed-in user per day. Signed-in users are never subject to
the IP or global limits.

All three values must be non-negative integers. Anything else stops the new revision from starting, and Cloud Run keeps
serving the previous one.

### How the API finds the visitor's IP

The app never sees the visitor's connection. On Cloud Run, Google's front end terminates the connection and opens a new
one to the container, so the socket address is always Google's:

```
browser ──► Google Front End (Cloud Run) ──► container
```

Each proxy **appends** the address that connected to it to the `X-Forwarded-For` header. Whatever the client put in that
header stays on the left and can be forged:

```
X-Forwarded-For: 192.0.2.66 (fake, written by the client), 203.0.113.7 (appended by Google)
```

The app builds the chain `[...X-Forwarded-For entries, socket address]` and uses the address `TRUST_PROXY_HOPS` places
from the right. This is the same rule as Express's `trust proxy` setting. With `1` on Cloud Run that's the entry Google
appended, which the client can't forge. IPv6 addresses are grouped by /64, because one home or phone usually gets a whole
/64. If the chosen entry isn't a valid IP, the per-IP limit is skipped for that request and `client_ip_unknown` is logged.

### Which calls this applies to

Only `POST /api/v1/chat` is limited per IP, and the frontend calls it **from the browser**, so the IP is the visitor's.
These endpoints are called from the **Next.js server**, so the API sees the frontend's Cloud Run IP, shared by all
visitors: `POST /auth/refresh`, `POST /auth/logout`, `GET /resources/:id`, `GET /subjects`, `GET /subjects/:slug`.
None of them have per-IP limits. **Never move the chat call to the Next.js server** (API route, server action, rewrite):
all visitors would then share the 20-a-day network limit.

### What a wrong `TRUST_PROXY_HOPS` does

| Setting | Effect | How you notice |
|---|---|---|
| **Too low** (e.g. `0` on Cloud Run, or `1` behind a load balancer) | The proxy's own address is used: **every visitor shares one IP**, so anonymous chat stops for everyone after 20 questions a day | `chat_limit_reached` with `scope: "ip"` shows up in the logs a lot. Check 2 below shows one network |
| **Too high** (e.g. `2` on Cloud Run directly) | A client-written entry is used: the per-IP limit **can be bypassed** by faking `X-Forwarded-For`. The session and global limits still apply | Silent. Check 1 below catches it |

### Verify before a release gets traffic

There's no staging environment, but Cloud Run can deploy a new revision that **gets no traffic** and has its own URL.
It runs on the real infrastructure (same front end, database and Gemini), so the checks below can run before any
visitor reaches the new version:

```sh
# 1. Build and push the image only (cloudbuild.api.yaml would also deploy it with traffic)
gcloud builds submit --tag=$IMAGE --project=$PROJECT_ID .

# 2. Deploy it as a revision tagged "candidate" that receives no traffic.
#    Settings not listed here are kept from the current revision.
gcloud run deploy <service> --image=$IMAGE --region=$REGION --project=$PROJECT_ID \
  --no-traffic --tag=candidate \
  --update-env-vars=TRUST_PROXY_HOPS=1,ANON_IP_DAILY_LIMIT=20,ANON_GLOBAL_DAILY_LIMIT=1000
#    gcloud prints the candidate URL: https://candidate---<service>-<hash>.<region>.run.app

# 3. Run Check 1 and the pre-traffic form of Check 2 (below) against the candidate URL.

# 4. Send all traffic to it (and let future deploys go live as usual)
gcloud run services update-traffic <service> --to-latest --region=$REGION --project=$PROJECT_ID
```

The checks use the production database, so they use up your own IP's anonymous questions for the day and add about 20
to the global count. That doesn't matter.

### Verify after deploying (and after any change in front of the API)

**Check 1: fake IPs don't get around the limit.** Run this from your machine against the URL the browser calls. It sends
21 anonymous questions, each from a new session with a different fake `X-Forwarded-For`. It costs about 20 tiny Gemini
calls and uses up your own IP's anonymous questions for the day.

```sh
API="https://REPLACE-WITH-API-URL"   # the Cloud Run URL the frontend calls
command -v uuidgen >/dev/null || uuidgen() { cat /proc/sys/kernel/random/uuid; }   # Linux without uuidgen
for i in $(seq 1 21); do
  code=$(curl -s -o /tmp/cc-chat.out -w '%{http_code}' -X POST "$API/api/v1/chat" \
    -H 'Content-Type: application/json' \
    -H "X-Session-ID: $(uuidgen)" \
    -H "X-Forwarded-For: 198.51.100.$i" \
    -d '{"message":"hi"}')
  echo "$i: $code $([ "$code" = 429 ] && cat /tmp/cc-chat.out)"
done
```

This script was tested against the app behind a proxy that behaves like Cloud Run's front end (`429` on the 21st), and
without one (all `200`, the misconfiguration case).

Expected: `429` with *"Too many questions from your network today…"* **by the 21st request at the latest**. It comes
earlier if your IP already asked questions today. If all 21 return `200`, faked IPs are being trusted: `TRUST_PROXY_HOPS`
is too high, or the IP limit is off (`ANON_IP_DAILY_LIMIT=0`).

**Check 2: visitors aren't sharing one IP.** Once there's been real anonymous traffic (e.g. the next day):

```sql
SELECT query_date,
       COUNT(*) FILTER (WHERE identity_type = 'anon') AS anonymous_sessions,
       COUNT(*) FILTER (WHERE identity_type = 'ip')   AS networks,
       MAX(count) FILTER (WHERE identity_type = 'ip') AS busiest_network_questions
FROM chat_usage
WHERE query_date >= CURRENT_DATE - 7
GROUP BY query_date ORDER BY query_date DESC;
```

Healthy: `networks` grows with `anonymous_sessions`. Misconfigured (hops too low): `networks` is `1` every day while there
are many sessions.

*Pre-traffic form* (against a candidate revision, or right after a deploy): ask one anonymous question from **two
different networks**, e.g. your laptop on Wi-Fi and again with the laptop tethered to a phone on mobile data. Then:

```sql
SELECT COUNT(*) FROM chat_usage WHERE identity_type = 'ip' AND query_date = CURRENT_DATE;
```

Run it before and after. It should go up by **2**. If it goes up by 1, both networks were counted as the same IP
(hops too low). Before this release no version wrote `ip` rows, so during a candidate test only your requests add them.

### Monitoring

Both events are structured logs (`jsonPayload.event`) with severity `WARNING`:

```sh
# Limits reached: scope "ip" (one network) or "global" (all anonymous chat is off until midnight UTC)
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="chat_limit_reached"' \
  --project=$PROJECT_ID --freshness=1d --format='value(timestamp, jsonPayload.scope)'

# Requests whose client IP couldn't be determined (should never happen on Cloud Run)
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="client_ip_unknown"' \
  --project=$PROJECT_ID --freshness=1d
```

Worth setting up [log-based alerts](https://cloud.google.com/logging/docs/alerting/log-based-alerts) for
`scope="global"` (anonymous chat is off for everyone, possibly an attack) and for any `client_ip_unknown`. Occasional
`scope="ip"` entries are normal: a shared office or campus network, or someone rotating sessions.

To choose `ANON_GLOBAL_DAILY_LIMIT`, look at normal anonymous volume and set it a few times higher:

```sql
SELECT query_date, count FROM chat_usage WHERE identity = 'global:anon' ORDER BY query_date DESC LIMIT 30;
```

### Changing limits, and emergency switches

- **Permanently:** change the substitution in `cloudbuild.api.yaml` (or pass `--substitutions`) and deploy.
- **Immediately**, without a build (creates a new revision in about a minute):
  ```sh
  gcloud run services update <service> --region=$REGION --project=$PROJECT_ID \
    --update-env-vars=ANON_IP_DAILY_LIMIT=0          # e.g. visitors wrongly share one IP
  ```
  The next Cloud Build deploy sets every env var back to the substitution values (`--set-env-vars` replaces them all),
  so make the same change in `cloudbuild.api.yaml` too.
- New limits apply right away to today's counts. Lowering a limit below today's count blocks that counter until midnight UTC.

### Revisit `TRUST_PROXY_HOPS` whenever the path to the API changes

| Change | What to do |
|---|---|
| Add a Google Cloud external Application Load Balancer (needed for Cloud Armor, Cloud CDN, serverless NEGs) | `TRUST_PROXY_HOPS=2`, **and** set the service's ingress to `internal-and-cloud-load-balancing`. Otherwise anyone can call the `run.app` URL directly and fake the entry the app now trusts |
| Put Cloudflare or another CDN/WAF in front | Add one hop per proxy, and make sure the origin only accepts traffic from the CDN (same reason) |
| Firebase Hosting rewrites, or a custom domain in front of the API | It may add a proxy. Run Check 1 and Check 2 |
| Route any per-IP-limited call through the Next.js server | Don't (see above). If it's ever unavoidable, the frontend must forward the visitor's IP and the API must verify that with a shared secret. That needs new code |
| **Move off Cloud Run** | Count the proxies on the new platform. Plain VM or container with a public IP and no proxy: `0`. Behind nginx, Traefik, Caddy or a Kubernetes ingress: the number of proxies, each configured to *append* to `X-Forwarded-For` (nginx: `$proxy_add_x_forwarded_for`). PaaS such as Fly.io, Render, Railway or Heroku: read their docs, since some use a different header (e.g. `Fly-Client-IP`), which would need a code change. A runtime other than Node (`@hono/node-server`: e.g. Bun, Deno, Workers) also needs `clientKey()` in `src/lib/client-ip.ts` updated to read the socket address; until then the per-IP limit is skipped and `client_ip_unknown` is logged. Then run Check 1 and Check 2 |

### Other requirements

- **Cloud SQL must use UTC** (the default; check with `SHOW timezone;`). The limits count per `CURRENT_DATE` and reset at
  midnight UTC, and `Retry-After` is calculated on that basis.
- **Privacy:** IPs are never stored or logged. Each is stored as `ip:<HMAC-SHA256 of date + IP>`, keyed with a key
  derived from `JWT_SECRET`, so it can't be reversed or linked across days. The rows are covered by the `chat_usage`
  retention item in the README To do list.
- **Rotating `JWT_SECRET`** (which already signs everyone out) also restarts today's per-IP counts. That's harmless.
