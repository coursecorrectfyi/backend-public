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
  --substitutions=_TAG=latest,_REGION=$REGION,_REPO=$AR_REPO,_SERVICE=cc-backend,_ALLOWED_ORIGINS=https://example.com
```

Substitutions and their defaults are listed at the bottom of the file; override `_SECRETS` if your secret names differ. The Cloud Run service also needs the Cloud SQL connection attached once:

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
