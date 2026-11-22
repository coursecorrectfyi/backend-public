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

Create a PostgreSQL instance with the `vector` extension available, **pgvector 0.8 or later** (Cloud SQL supports pgvector), a database and an application user. The application user needs to be able to create objects in the `public` schema:

```sql
GRANT CREATE ON SCHEMA public TO <app_user>;
GRANT USAGE ON SCHEMA public TO <app_user>;
```

Apply the migrations (see [Migrations](#migrations), which applies to every release as well).


On Cloud Run, `DATABASE_URL` must use the Unix socket form:

```
postgresql://<app_user>:<password>@/<db>?host=/cloudsql/<SQL_CONNECTION>
```

### Migrations

**Migrations are not applied automatically.** The deploy (`cloudbuild.api.yaml`) doesn't run them, the Docker image
doesn't contain them, and the API doesn't migrate when it starts. Apply them by hand, **before deploying a release
whose `migrations/` folder has new files** since the last release (and once when setting up a new database).
Automating this is in the [backlog](backlog.md#engineering).

From a machine that can reach the database, for example through
[Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy), with the release's code checked out:

```sh
cloud-sql-proxy "$SQL_CONNECTION" --port=5432 &
DATABASE_URL=postgresql://<app_user>:<password>@localhost:5432/<db> npx drizzle-kit migrate
```

How it behaves:
- **Only pending migrations run.** Drizzle records each applied migration in `drizzle.__drizzle_migrations`, so running
  it again does nothing. All pending migrations run in **one transaction**: if one fails, none are applied.
- **What's pending** is decided by timestamp, not by name: every migration whose `when` in
  `migrations/meta/_journal.json` is later than the newest `created_at` in the table. To see what's applied:
  `SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at;`. A migration generated on a machine
  with a wrong clock (a `when` earlier than the last applied one) would be **silently skipped**: check that a new
  migration's `when` is later than the previous entry's before releasing.
- **No down migrations.** Undoing one means writing the reverse SQL by hand. Before a risky migration, take an
  on-demand backup: `gcloud sql backups create --instance=$SQL_INSTANCE --project=$PROJECT_ID`.

**Keep each migration compatible with the version that's running.** A migration is applied while the previous
version still serves traffic, and a rollback goes back to that version, so both versions must work with the new schema:
- Fine in one release: new tables, new nullable columns or columns with a default, new indexes.
- In two releases: renaming or dropping a column or table, or making an existing column `NOT NULL` without a
  default. First release the code that no longer uses the old form, then the migration that removes it.
- Large tables: a plain `CREATE INDEX` locks writes while it builds. `CREATE INDEX CONCURRENTLY` doesn't, but it
  can't run inside the migration transaction, so run it by hand first and make the migration `CREATE INDEX IF NOT EXISTS`.

### The halfvec migration (0007)

`0007_halfvec_embeddings` stores embeddings as `halfvec(768)` (16-bit floats) instead of `vector(768)`. Measured on a
copy of the catalogue (~74k resources):
- HNSW index 288 → 144 MB, table 833 → 538 MB; embeddings are stored in the row instead of TOAST;
- search after a restart (cold cache) about 2× faster on a 1 GB VM, warm unchanged;
- the same results: for 10 query vectors, all 60 of the top-6 chat retrieval results were identical.

At ~150k resources the `vector` index would be ~580 MB (more than a 1 GB VM can cache), the `halfvec` one ~290 MB.

**It rewrites the table and rebuilds all of its indexes under an exclusive lock.** Search, course pages and chat wait
until it's done: minutes on a small VM, mostly the HNSW build. So it isn't applied to the live database. It runs on the
new VM between restore and switch:

1. **Restore the dump.** Optionally, leave out the old HNSW index, which the migration would drop straight away
   (saves one full index build):

   ```sh
   pg_restore --list cloudsql.dump | grep -v 'learning_resources_embedding_idx' > restore.list
   pg_restore --dbname="$VM_DATABASE_URL" --no-owner --use-list=restore.list cloudsql.dump
   ```

   The dump includes `drizzle.__drizzle_migrations`, so the next step applies only 0007 (and any later migration).
2. **Give the index build enough memory**, so the HNSW graph is built in memory (pgvector prints a notice when it
   doesn't fit, and the build gets much slower). About 256 MB is enough for 74k resources:

   ```sql
   ALTER DATABASE <db> SET maintenance_work_mem = '256MB';  -- new sessions, including the migration's
   ```

3. **Apply the migrations** as usual (`npx drizzle-kit migrate` with the VM's `DATABASE_URL`): `0007`, and `0008`
   ([the search vocabulary](#the-search-vocabulary-0008)). Then fill the vocabulary, undo step 2, and refresh the
   planner statistics, which a restore doesn't bring along:

   ```sh
   DATABASE_URL="$VM_DATABASE_URL" npm run search:vocabulary
   ```

   ```sql
   ALTER DATABASE <db> RESET maintenance_work_mem;
   ANALYZE;
   ```

4. **Check:**

   ```sql
   SELECT format_type(atttypid, atttypmod) FROM pg_attribute
   WHERE attrelid = 'learning_resources'::regclass AND attname = 'embedding';             -- halfvec(768)
   SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) FROM pg_indexes
   WHERE tablename = 'learning_resources' AND indexdef LIKE '%USING hnsw%';               -- lr_embedding_hnsw_idx, ~144 MB
   ```

5. **Switch the API** to the VM.

**Either release order works** (both checked in `test/db/halfvec.test.ts`):
- Releases before this one cast the query vector to `vector`. Postgres converts it to `halfvec` implicitly and uses the
  new index, so an older release can run against the migrated database, and rolling back to one is safe.
- From this release on, the query vector is passed uncast and takes the column's type, so this release also works on
  a database without the migration (Cloud SQL), with its `vector` index.

If it ever has to run on a live database: plan a maintenance window, or do it over two releases without the long
lock. Add a `halfvec` column, backfill it in batches, build its index with `CREATE INDEX CONCURRENTLY`, switch the
code, then drop the old column.

### The search vocabulary (0008)

`0008_search_vocabulary` creates the `pg_trgm` and `fuzzystrmatch` extensions and the `search_vocabulary` table,
which search uses to correct typos ([search.md](search.md#operations)).
- **Extensions:** both ship with Postgres (contrib: `postgresql-contrib`/PGDG packages, and Cloud SQL) and are
  *trusted*, so a user with `CREATE` on the database can create them. On Cloud SQL, if the application user can't, run
  the two `CREATE EXTENSION` lines as `postgres` first (they're `IF NOT EXISTS`).
- **Safe while the previous release runs:** it only adds an empty table.
- **After applying it**, fill the table: `npm run search:vocabulary` (seconds). The embed job refreshes it at the end
  of every run. Until the first refresh, typo correction is simply off.

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
The abuse-limit substitutions (`_TRUST_PROXY_HOPS`, `_ANON_IP_DAILY_LIMIT`, `_ANON_GLOBAL_DAILY_LIMIT`,
`_SIGNED_IN_GLOBAL_DAILY_LIMIT`, `_RATE_LIMIT_*`, `_AUTH_ALLOWED_PROVIDERS`) are explained in
[6. Client IP and abuse limits](#6-client-ip-and-abuse-limits). **Read that section before putting anything (load
balancer, CDN, proxy) in front of the API, or moving the API off Cloud Run.** The Cloud Run service also needs the Cloud SQL connection attached once:

```sh
gcloud run services update cc-backend --add-cloudsql-instances=$SQL_CONNECTION --region=$REGION --project=$PROJECT_ID
```

If the database runs on a VM in your VPC instead of Cloud SQL, attach the network once instead (the VM's private IP
goes in `DATABASE_URL`):

```sh
gcloud run services update cc-backend --network=default --subnet=default --vpc-egress=private-ranges-only \
  --region=$REGION --project=$PROJECT_ID
```

Deploys keep both settings: `gcloud run deploy` changes only the flags it's given.

**Clean up old images.** Every deploy pushes a new image, and Artifact Registry bills storage above its free tier. A
cleanup policy keeps the last 10 (enough to roll back) and deletes older ones:

```sh
cat > cleanup-policy.json <<'JSON'
[
  {"name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 10}},
  {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "30d"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies $AR_REPO --policy=cleanup-policy.json \
  --location=$REGION --project=$PROJECT_ID --dry-run
```

With `--dry-run` the policy only logs what it would delete. Once that looks right, run the same command with
`--no-dry-run`.

Keep rules win over delete rules, so the 10 newest images stay whatever their age.

## 3. Batch jobs

The jobs run from the same image as the API; the entry point is chosen per job with `--command` / `--args`.

| Job | `--args` | Suggested resources | Env vars |
|---|---|---|---|
| `embedder` | `dist/jobs/embed.js` | 1 CPU / 1Gi, 24h timeout | optional `PROVIDER` |
| `insights-batch` | `dist/jobs/insights/batch.js` | 1 CPU / 1Gi, 6h timeout, `--max-retries=0` | `INSIGHTS_PROVIDER`, `TOP_N`, `CONCURRENCY`, `BATCH_DELAY_MS` |
| `chat-usage-retention` | `dist/jobs/chat-usage-retention.js` | 1 CPU / 512Mi, 10m timeout, `--max-retries=1` | optional `CHAT_USAGE_RETENTION_DAYS` (default 7, at least 2) |

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

- **`embedder`** fills `learning_resources.embedding` for rows where it is `NULL`. It then rebuilds the search
  vocabulary (typo correction; not in a dry run) and exits. Run it after new resources are added. Order after an
  ingestion: ingestion → `embedder` → `insights-batch` (optional). It needs migrations `0007` and `0008`. To rebuild
  only the vocabulary (e.g. after deactivating resources), run `npm run search:vocabulary` from a machine that reaches
  the database.
- **`insights-batch`** generates `ai_insights` for the top-ranked resources (`rating × ln(num_ratings + 1)`) that don't have them yet.
- **`chat-usage-retention`** keeps `chat_usage` (daily chat counters, which hold pseudonymous identifiers) to the last
  7 days. It first saves each completed day's totals to `chat_usage_daily` (counts only), then deletes older rows, in
  one transaction. Running it twice is harmless. **Run it daily** (below). It needs nothing but the database:
  ```sh
  gcloud run jobs create chat-usage-retention \
    --image=$IMAGE --region=$REGION --project=$PROJECT_ID \
    --service-account=$JOBS_SA \
    --set-cloudsql-instances=$SQL_CONNECTION \
    --set-secrets=DATABASE_URL=database-url:latest \
    --command=node --args=dist/jobs/chat-usage-retention.js \
    --cpu=1 --memory=512Mi --task-timeout=10m --max-retries=1
  ```
  A run takes seconds, so its compute cost is negligible. It logs `chat_usage_retention` (rows summarized and deleted)
  or, on failure, `chat_usage_retention_failed` and exits with an error.

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

The retention job, daily at 03:30 UTC (after the day has ended, and after the last possible refund of the previous day):

```sh
gcloud scheduler jobs create http chat-usage-retention-daily \
  --schedule="30 3 * * *" --time-zone=UTC --location=$REGION --project=$PROJECT_ID \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/chat-usage-retention:run" \
  --http-method=POST --message-body='{}' --oauth-service-account-email="$SA"
```

Cloud Scheduler includes 3 jobs per billing account for free, then about $0.10 per job per month.

Use `gcloud scheduler jobs pause|resume|delete <scheduler-job> --location=$REGION` to manage them.

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

The API limits two things per visitor IP:
- **anonymous chat questions per day**, so that making up new `X-Session-ID`s doesn't give unlimited free questions
  (`src/api/chat-usage.ts`);
- **requests per minute** on every route, so one client can't flood search (a paid embedding call each), login or the
  database (`src/api/middleware/rate-limit.ts`).

Both only work if the API identifies the visitor's IP correctly. For calls the browser makes, that depends on what
sits in front of the API (`src/lib/client-ip.ts`). For calls the Next.js server makes for a visitor, on the server
naming the visitor with a shared secret ([trusted relay](#trusted-relay-the-nextjs-server), `src/lib/relay.ts`). The client-facing contract is in [api.md](api.md#rate-limits), and the short list of what to do
per release and what to monitor is in [operations.md](operations.md).

### Settings

| Env var (Cloud Build substitution) | Default | Meaning |
|---|---|---|
| `TRUST_PROXY_HOPS` (`_TRUST_PROXY_HOPS`) | `1` | Number of proxies between the internet and the app. **`1` = Cloud Run reached directly**, which is our setup |
| `ANON_IP_DAILY_LIMIT` (`_ANON_IP_DAILY_LIMIT`) | `20` | Anonymous questions per visitor IP (IPv6: per /64) per UTC day, across all sessions. `0` = off |
| `ANON_GLOBAL_DAILY_LIMIT` (`_ANON_GLOBAL_DAILY_LIMIT`) | `1000` | Anonymous questions per UTC day from all visitors together: a hard ceiling on anonymous chat cost. `0` = no limit (**not** "chat off") |
| `CHAT_MODE` (`_CHAT_MODE`) | `on` | **Emergency switch for chat:** `on`, `signed_in_only` (anonymous questions refused) or `off` (every question refused). Refused questions get `503` before any paid work |
| `SIGNED_IN_GLOBAL_DAILY_LIMIT` (`_SIGNED_IN_GLOBAL_DAILY_LIMIT`) | `1000` | Signed-in questions per UTC day from all users together: a ceiling in case accounts turn out cheap to create ([auth-providers.md](auth-providers.md)). `0` = no limit |
| `TRUSTED_RELAY_SECRETS` (Secret Manager `trusted-relay-secrets`, in `_SECRETS`) | none | The secret(s) the Next.js server sends in `X-Relay-Secret` to name the visitor it calls for. One, or two while rotating, separated by a space; each at least 32 characters. None = no server is trusted ([trusted relay](#trusted-relay-the-nextjs-server)) |
| `AUTH_ALLOWED_PROVIDERS` (`_AUTH_ALLOWED_PROVIDERS`) | `google.com` | Firebase sign-in methods that may log in, separated by spaces or commas (spaces in `cloudbuild.api.yaml`). Read [auth-providers.md](auth-providers.md) before adding one. Unknown ids and `anonymous` stop the revision from starting |
| `RATE_LIMIT_MODE` (`_RATE_LIMIT_MODE`) | `enforce` in code, **`shadow` in `cloudbuild.api.yaml`** for now | `enforce`: requests over a per-minute limit get `429`. `shadow`: nothing is rejected, requests over the limit are only logged ([rolling out](#rolling-out-the-per-minute-limits-shadow--enforce)) |
| `RATE_LIMIT_CHAT_PER_MIN` (`_RATE_LIMIT_CHAT_PER_MIN`) | `10` | Chat requests per IP per minute, signed in or not. `0` = off |
| `RATE_LIMIT_SEARCH_PER_MIN` (`_RATE_LIMIT_SEARCH_PER_MIN`) | `60` | Searches per IP per minute. `0` = off |
| `RATE_LIMIT_LOGIN_PER_MIN` (`_RATE_LIMIT_LOGIN_PER_MIN`) | `20` | Logins per IP per minute. `0` = off |
| `RATE_LIMIT_DEFAULT_PER_MIN` (`_RATE_LIMIT_DEFAULT_PER_MIN`) | `120` | Saved courses, `/health` and unknown paths together, per IP per minute. `0` = off |

Fixed in code: 5 questions per anonymous session and 10 per signed-in user per day. Signed-in users are never subject to
the anonymous limits (per IP, anonymous total), and anonymous visitors never to the signed-in total. The per-minute
limits apply to everyone.

The numbers must be non-negative integers, the modes one of the listed values, and the providers known Firebase ids.
Anything else stops the new revision from starting, and Cloud Run keeps serving the previous one.

**The per-minute limits are per instance.** Each Cloud Run instance counts in its own memory, so a client whose
requests are spread over several instances can get up to (instances × limit) per minute, at most 3× with
`_MAX_INSTANCES=3`. That's fine for their purpose: stopping one client from flooding the paid APIs and the database.
An exact shared count would need Redis (Memorystore, about $35/month at minimum) or a database write per request (the load
we're trying to avoid), and neither is worth it at this scale. For a true global per-IP limit, see Cloud Armor in
[monitoring.md, "Not now"](monitoring.md#not-now).

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
/64. If the chosen entry isn't a valid IP, the per-IP limits are skipped for that request and `client_ip_unknown` is logged.

### Trusted relay (the Next.js server)

When the Next.js server calls the API for a visitor (server-side rendering, NextAuth's token refresh, ...), the API
sees the server's IP, shared by every visitor. So the server sends two headers on every such call, and the API counts
the call as that visitor (contract: [api.md](api.md#calls-from-a-server-on-a-visitors-behalf)):

```
X-Relay-Secret: <the shared secret>
X-Visitor-IP:   <the visitor's IP: on Cloud Run, the LAST entry of the X-Forwarded-For header the Next.js server received>
```

The API uses `X-Visitor-IP` only with a valid secret. A call without the headers counts as the server's own IP.

**Create the secret** (once). It is stored twice: `trusted-relay-secrets` is what the API accepts (one value, or two
while rotating), `api-relay-secret` is what the frontend sends (always exactly one value). Normally both hold the same value.

```sh
RELAY_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
printf '%s' "$RELAY_SECRET" | gcloud secrets create trusted-relay-secrets --data-file=- --project=$PROJECT_ID
printf '%s' "$RELAY_SECRET" | gcloud secrets create api-relay-secret --data-file=- --project=$PROJECT_ID
unset RELAY_SECRET
# The API reads trusted-relay-secrets as TRUSTED_RELAY_SECRETS (cloudbuild.api.yaml, _SECRETS).
# The frontend's Cloud Run service gets api-relay-secret as a server-only env var, e.g.:
gcloud run services update <frontend-service> --region=$REGION --project=$PROJECT_ID \
  --update-secrets=API_RELAY_SECRET=api-relay-secret:latest
```

Each service's service account needs `roles/secretmanager.secretAccessor` on its secret. A new secret version only
reaches a service with a new revision (deploy, or `gcloud run services update`).

**Rotate** (e.g. once a year, or at once if it may have leaked), without downtime:
1. The API accepts both: `printf '%s %s' "$NEW" "$OLD" | gcloud secrets versions add trusted-relay-secrets --data-file=-`,
   then roll the API (`gcloud run services update <service> --region=$REGION --project=$PROJECT_ID`).
2. The frontend sends the new one: `printf '%s' "$NEW" | gcloud secrets versions add api-relay-secret --data-file=-`,
   then roll the frontend.
3. The API drops the old one: `printf '%s' "$NEW" | gcloud secrets versions add trusted-relay-secrets --data-file=-`,
   then roll the API again. Check there's no `relay_auth_failed` afterwards.

If a secret leaks, whoever has it can claim any visitor IP through the API and get around every per-visitor limit
(the session and daily totals still apply). Rotate at once; the emergency switches below limit damage meanwhile.

**What can go wrong:**

| Problem | Effect | How you notice |
|---|---|---|
| The frontend sends no relay headers on some calls | Those calls count as the frontend's IP: all visitors share one budget, and once enforced, server-rendered pages get `429`s | `rate_limit_summary` with `clients: 1` and a high `max_per_client` during normal hours (shadow review below) |
| The secret differs between the two services (e.g. rotated on one side only), or the API has none | Same as above | `relay_auth_failed` with `invalid_secret` (in the monitoring alert) |
| The frontend sends no visitor IP, or something that isn't one address | Same as above | `relay_auth_failed` with `missing_visitor_ip` / `invalid_visitor_ip` |
| The frontend takes the wrong `X-Forwarded-For` entry: a proxy's private address | Every visitor shares that address | `relay_auth_failed` with `non_public_visitor_ip` |
| The frontend takes the **first** `X-Forwarded-For` entry (written by the visitor's client) | Visitors can pick their own IP through server-rendered calls and get around per-IP limits | Silent. Review the frontend code: it must take the last entry on Cloud Run |

### What a wrong `TRUST_PROXY_HOPS` does

| Setting | Effect | How you notice |
|---|---|---|
| **Too low** (e.g. `0` on Cloud Run, or `1` behind a load balancer) | The proxy's own address is used: **every visitor shares one IP**, so anonymous chat stops for everyone after 20 questions a day, and everyone shares one per-minute budget (with enforcement on: site-wide `429`s) | `proxy_hops_mismatch` with `likely: "hops_too_low"`. `chat_limit_reached` with `scope: "ip"` shows up a lot. `rate_limit_summary` with `clients: 1`. Check 2 below shows one network |
| **Too high** (e.g. `2` on Cloud Run directly) | A client-written entry is used: the per-IP limits **can be bypassed** by faking `X-Forwarded-For`. The session and global limits still apply | `proxy_hops_mismatch` with `likely: "hops_too_high_or_proxy_bypassed"`. Check 1 below catches it |

`proxy_hops_mismatch` (`src/api/middleware/proxy-check.ts`) compares the number of `X-Forwarded-For` entries with
`TRUST_PROXY_HOPS`. Browsers don't send the header, so normally there's exactly one entry per proxy. It warns at most
once per minute per instance, and only when most of at least 20 requests in that minute don't match. Running locally
(`npm run dev`) without `TRUST_PROXY_HOPS=0` triggers it too, which is correct: nothing is in front of the app there.

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
  --update-env-vars=TRUST_PROXY_HOPS=1,ANON_IP_DAILY_LIMIT=20,ANON_GLOBAL_DAILY_LIMIT=1000,SIGNED_IN_GLOBAL_DAILY_LIMIT=1000,RATE_LIMIT_MODE=shadow,AUTH_ALLOWED_PROVIDERS=google.com
#    gcloud prints the candidate URL: https://candidate---<service>-<hash>.<region>.run.app

# 3. Run Check 1, the pre-traffic form of Check 2, Check 3 and Check 4 (below) against the candidate URL.
#    Check 5 needs the frontend; run it after the release.

# 4. Send all traffic to it (and let future deploys go live as usual)
gcloud run services update-traffic <service> --to-latest --region=$REGION --project=$PROJECT_ID
```

The checks use the production database, so they use up your own IP's anonymous questions for the day and add about 20
to the global count. That doesn't matter.

### Verify after deploying (and after any change in front of the API)

**Check 1: fake IPs don't get around the limit.** Run this from your machine against the URL the browser calls. It sends
21 anonymous questions, each from a new session with a different fake `X-Forwarded-For`. It costs about 20 tiny Gemini
calls and uses up your own IP's anonymous questions for the day. After the first 10 it waits 7 seconds between
questions, to stay under the per-minute chat limit (10 a minute, then one every 6 seconds), so it takes about 2 minutes.

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
  [ "$i" -ge 10 ] && sleep 7
done
```

This script was tested against the app behind a proxy that behaves like Cloud Run's front end (`429` on the 21st), and
without one (all `200`, the misconfiguration case).

Expected: `429` with `"code":"daily_limit","scope":"ip"` and *"Too many questions from your network today…"* **by the
21st request at the latest**. It comes earlier if your IP already asked questions today. If all 21 return `200`, faked
IPs are being trusted: `TRUST_PROXY_HOPS` is too high, or the IP limit is off (`ANON_IP_DAILY_LIMIT=0`). A `429` with
`"code":"rate_limited"` means the script ran faster than the per-minute limit allows: it says nothing about the daily
limit, so wait a minute and run it again.

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

**Check 3: the per-minute limits work.** Sends 61 searches in a burst, one more than the search budget, from your
machine. Each costs one tiny embedding call.

```sh
API="https://REPLACE-WITH-API-URL"
for i in $(seq 1 61); do
  curl -s -o /dev/null -w '%{http_code} ' "$API/api/v1/resources/search?q=python"
done; echo
```

- **Enforce mode:** expected `200` × 60, then `429`. If there's more than one instance running, your requests may be
  spread over them and each counts separately: keep sending, and a `429` comes by request 181 at the latest with 3
  instances. All `200` means the limits are off or the IP isn't identified (check `client_ip_unknown` below).
- **Shadow mode:** all `200`. To see the log, send one more request **a minute later** (the summary is written by the
  first request after the minute ends), then:
  ```sh
  gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="rate_limit_summary"' \
    --project=$PROJECT_ID --freshness=10m --format=json
  ```
  Expected: a line with `"mode": "shadow"`, `"over_limit": 1` (or more) and `"by_group": {"search": ...}`.

**Check 4: Google sign-in still works.** Sign in on the live site with the browser's developer tools open (Network
tab), and copy the `idToken` from the request body of `/api/v1/auth/firebase/login`. It's valid for an hour. Send it to
the candidate:

```sh
curl -s -X POST "$API/api/v1/auth/firebase/login" -H 'Content-Type: application/json' \
  -d '{"idToken":"PASTE-ID-TOKEN"}' | head -c 300; echo
```

Expected: `200` with `"provider":"google"` in `user`. A `403` with `provider_not_allowed` means `AUTH_ALLOWED_PROVIDERS`
doesn't include `google.com`. (The token is a credential: don't paste it anywhere else.)

**Check 5: relayed calls count per visitor** (once the frontend sends the relay headers). Watch the logs for a day:
there should be no `relay_auth_failed`, and no `rate_limit_summary` lines with `clients: 1` and a high `max_per_client`
for routes the Next.js server calls. To test the API side directly in enforce mode, with the secret in your shell
(`RELAY_SECRET="$(gcloud secrets versions access latest --secret=api-relay-secret --project=$PROJECT_ID)"`):

```sh
# 121 relayed calls, each for a different visitor: all 200 (each visitor has its own budget of 120)
for i in $(seq 1 121); do
  curl -s -o /dev/null -w '%{http_code} ' "$API/api/v1/subjects" \
    -H "X-Relay-Secret: $RELAY_SECRET" -H "X-Visitor-IP: 198.51.100.$((i % 250 + 1))"
done; echo
```

Without the two headers, the same loop gets a `429` by the 121st call (all counted as your IP).

### Rolling out the per-minute limits (shadow → enforce)

The per-minute limits first ship in **shadow mode** (`_RATE_LIMIT_MODE: 'shadow'` in `cloudbuild.api.yaml`): nothing is
rejected, and each instance logs a `rate_limit_summary` line in any minute where requests went over a limit. This checks
the budgets, and that the Next.js server sends the relay headers, against real traffic before anyone can be blocked.

**How long:** at least **7 days** (a full weekly cycle, so weekday peaks are included), and **no longer than 14 days**
without a reason. During shadow mode the per-minute limits protect nothing. If a real flood hits during that time,
switch to enforce at once (step 3), even before the 7 days are up.

1. Deploy as usual, and run Check 3 in its shadow form.
2. Glance at the summaries after the first day (to catch a badly wrong budget early), and review them properly at day 7:
   ```sh
   gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="rate_limit_summary"' \
     --project=$PROJECT_ID --freshness=7d \
     --format='table(timestamp, jsonPayload.over_limit, jsonPayload.clients, jsonPayload.max_per_client, jsonPayload.by_group)'
   ```
   | What you see | Meaning | Action |
   |---|---|---|
   | Nothing, or only your own Check 3 | No real visitor would have been blocked | Switch to enforce |
   | A few lines, one client each, `max_per_client` high, at odd hours | Scripts or crawlers | Switch to enforce: that's what it's for |
   | Repeated lines for `login`, `search` or `default` with `clients: 1` and a high `max_per_client`, during normal hours | One IP sending a lot of legitimate traffic: probably the **Next.js server calling without the relay headers** (or with a wrong secret: look for `relay_auth_failed`), or a big shared network | **Don't enforce yet.** Find the caller in the Cloud Run request logs for that route (`httpRequest.remoteIp`, `httpRequest.userAgent`). Fix the caller or raise that group's budget |
   | Many lines with many clients | Budgets too tight for real use, or an attack spread over many IPs | Compare with normal traffic before deciding |

   Also check there's no `proxy_hops_mismatch` in the same period. If you change a budget or fix a caller, give the
   change a few more days of shadow before switching.
3. Switch, immediately and without a build:
   ```sh
   gcloud run services update <service> --region=$REGION --project=$PROJECT_ID --update-env-vars=RATE_LIMIT_MODE=enforce
   ```
   **and** set `_RATE_LIMIT_MODE: 'enforce'` in `cloudbuild.api.yaml`, otherwise the next deploy switches back to shadow.
4. Run Check 3 in its enforce form.

**Later changes:** use shadow mode again for at least 7 days before **lowering** a budget. The mode applies to all
groups at once, so that means shadowing all of them for the period (per-group shadow mode wasn't needed so far). Raising a budget or turning a group off
needs no shadow period.

### Monitoring

The events below are structured logs (`jsonPayload.event`). All are severity `WARNING`, except `auth_rejected` (`INFO`):

| Event | Written | Means |
|---|---|---|
| `chat_limit_reached` | per refused question, `scope` `ip`, `global` (anonymous total) or `signed_in_global` (signed-in total) | a shared daily chat limit was hit. The totals mean chat is off for that whole group until midnight UTC |
| `client_ip_unknown` | per chat question (`route: "chat"`), or once a minute per instance (`route: "rate_limit"`, with a `requests` count) | the visitor IP couldn't be determined, so per-IP limits were skipped |
| `rate_limit_summary` | once a minute per instance, only when something went over a limit | `over_limit` requests (rejected in enforce mode, let through in shadow), `by_group`, distinct `clients`, `max_per_client`. No IPs |
| `proxy_hops_mismatch` | once a minute per instance at most | the `X-Forwarded-For` shape doesn't match `TRUST_PROXY_HOPS` (see above) |
| `relay_auth_failed` | once a minute per instance at most, with a count per problem (`invalid_secret`, `missing_visitor_ip`, `invalid_visitor_ip`, `non_public_visitor_ip`) | a relay call was counted as the relay's own IP, or named a private address ([trusted relay](#trusted-relay-the-nextjs-server)). No secrets or addresses are logged |
| `auth_rejected` | per request with a bad token on `/saved` | `reason`, e.g. `JwtTokenExpired`. Routine; not worth an alert |


```sh
# Limits reached: scope "ip" (one network) or "global" (all anonymous chat is off until midnight UTC)
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="chat_limit_reached"' \
  --project=$PROJECT_ID --freshness=1d --format='value(timestamp, jsonPayload.scope)'

# Requests whose client IP couldn't be determined (should never happen on Cloud Run)
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="client_ip_unknown"' \
  --project=$PROJECT_ID --freshness=1d

# Per-minute limits: who went over, and whether TRUST_PROXY_HOPS matches the traffic
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event=("rate_limit_summary" OR "proxy_hops_mismatch")' \
  --project=$PROJECT_ID --freshness=1d --format=json
```

The alerts worth setting up (`scope="global"`, `client_ip_unknown`, `proxy_hops_mismatch`, floods), combined into one
log alert to keep the cost down, are in [monitoring.md §5](monitoring.md#5-one-log-alert-for-abuse-and-configuration-signals). Occasional
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
  # Real visitors are getting per-minute 429s: stop rejecting, keep logging
  #   --update-env-vars=RATE_LIMIT_MODE=shadow
  # Only one group is the problem, e.g. login: turn just that group off
  #   --update-env-vars=RATE_LIMIT_LOGIN_PER_MIN=0
  # Chat spend is running away, or chat is being abused: switch it off (or guests only)
  #   --update-env-vars=CHAT_MODE=off             (back with CHAT_MODE=on)
  #   --update-env-vars=CHAT_MODE=signed_in_only
  # Careful: setting a daily limit to 0 means "no limit", not "off". Use CHAT_MODE to stop chat.
  # A sign-in method is being abused to create accounts: stop accepting it
  #   --update-env-vars=AUTH_ALLOWED_PROVIDERS=google.com
  # The relay secret may have leaked: rotate it (see "Trusted relay"); meanwhile the daily totals bound chat spend
  ```
  The next Cloud Build deploy sets every env var back to the substitution values (`--set-env-vars` replaces them all),
  so make the same change in `cloudbuild.api.yaml` too.
- New daily limits apply right away to today's counts. Lowering a limit below today's count blocks that counter until
  midnight UTC. Per-minute counts start from zero in every new revision.

### Revisit `TRUST_PROXY_HOPS` whenever the path to the API changes

| Change | What to do |
|---|---|
| Add a Google Cloud external Application Load Balancer (needed for Cloud Armor, Cloud CDN, serverless NEGs) | `TRUST_PROXY_HOPS=2`, **and** set the service's ingress to `internal-and-cloud-load-balancing`. Otherwise anyone can call the `run.app` URL directly and fake the entry the app now trusts |
| Put Cloudflare or another CDN/WAF in front | Add one hop per proxy, and make sure the origin only accepts traffic from the CDN (same reason) |
| Firebase Hosting rewrites, or a custom domain in front of the API | It may add a proxy. Run Check 1 and Check 2 |
| The Next.js server starts calling another endpoint | Nothing on the API side, as long as it sends the relay headers ([trusted relay](#trusted-relay-the-nextjs-server)) |
| The Next.js server moves off Cloud Run, or gets a proxy in front | It must still send the visitor's address as *its* platform saw it: the entry its own nearest trusted proxy appended, never one the client wrote |
| **Move off Cloud Run** | Count the proxies on the new platform. Plain VM or container with a public IP and no proxy: `0`. Behind nginx, Traefik, Caddy or a Kubernetes ingress: the number of proxies, each configured to *append* to `X-Forwarded-For` (nginx: `$proxy_add_x_forwarded_for`). PaaS such as Fly.io, Render, Railway or Heroku: read their docs, since some use a different header (e.g. `Fly-Client-IP`), which would need a code change. A runtime other than Node (`@hono/node-server`: e.g. Bun, Deno, Workers) also needs `clientKey()` in `src/lib/client-ip.ts` updated to read the socket address; until then the per-IP limit is skipped and `client_ip_unknown` is logged. Then run Check 1 and Check 2 |

### Other requirements

- **Cloud SQL must use UTC** (the default; check with `SHOW timezone;`). The limits count per `CURRENT_DATE` and reset at
  midnight UTC, and `Retry-After` is calculated on that basis.
- **Privacy:** IPs are never stored or logged. Each is stored as `ip:<HMAC-SHA256 of date + IP>`, keyed with a key
  derived from `JWT_SECRET`, so it can't be reversed or linked across days. The rows are covered by the `chat_usage`
  retention item in the README To do list.
- **Rotating `JWT_SECRET`** (which already signs everyone out) also restarts today's per-IP counts. That's harmless.
