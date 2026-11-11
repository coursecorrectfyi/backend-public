# CourseCorrect Backend

Backend for [CourseCorrect](https://coursecorrect.fyi), a search and recommendation platform for online courses, programs and degrees.

One TypeScript codebase (Hono + Node.js, ESM) produces two kinds of deployables:

- **API service** (`src/index.ts`, `src/api/`): REST API with hybrid search (Postgres full-text + pgvector), saved courses, subjects and a streaming AI learning assistant ("Cora").
- **Batch jobs** (`src/jobs/`): enrich the course catalogue with vector embeddings and AI-generated insights.

Both share the Drizzle schema in `src/db/schema.ts`.

## Architecture

```
catalogue  learning_resources (+ course_reviews), populated by an ingestion pipeline not included here

embed      resources without embeddings → text-embedding-004 (768d) → pgvector column
insights   top-rated resources → LLM grounded with O*NET / BLS data → ai_insights JSON

API        /api/v1/*  search, detail, saved, subjects, chat (SSE)
```

Each job is idempotent and works off "what is still NULL" in the database, so jobs can be re-run safely.

**Search** ranks results by combining `ts_rank` over a trigger-maintained `search_document` tsvector with pgvector cosine similarity against the embedded query. **Chat** streams Gemini responses over SSE, grounded in the resources on the user's current page plus retrieved resources (RAG).

## Project layout

```
src/
  index.ts              API entry point (Hono)
  api/                  routes: auth, resources, saved, subjects, chat; rag.ts; middleware/
  db/                   schema.ts (Drizzle), client.ts, seeds/
  lib/                  shared code: embedding client, structured logger
  jobs/
    embed.ts            embeddings backfill
    insights/           AI insights (Vertex AI, Groq or Gemini)
    onet/               O*NET / BLS occupation data seed + lookup
migrations/             Drizzle SQL migrations
docs/                   deployment guide
```

## Getting started

Requirements: Node.js 22 (as in the Docker images), PostgreSQL 15+ with the [pgvector](https://github.com/pgvector/pgvector) extension, and a Google Cloud project with Vertex AI enabled (for embeddings, extraction and chat).

```sh
npm install
cp .env.example .env     # then fill in the values
npx drizzle-kit migrate  # create the schema
npm run topics:seed      # optional: seed the subject taxonomy
npm run dev              # API with hot reload on http://localhost:3000
```

Google Cloud APIs use [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials): run `gcloud auth application-default login` for local development.

> A self-contained local Postgres setup is not included yet.

## Configuration

All configuration is through environment variables (see `.env.example`).

| Variable | Used by | Description |
|---|---|---|
| `DATABASE_URL` | all | Postgres connection string. Cloud SQL Unix-socket URLs (`...@/db?host=/cloudsql/...`) are supported. |
| `GOOGLE_CLOUD_PROJECT` | all | Google Cloud project for Vertex AI and Firebase Admin. |
| `JWT_SECRET` | API | Secret for signing backend JWTs (`openssl rand -base64 48`). |
| `ALLOWED_ORIGINS` | API | Comma-separated CORS origins. Default `http://localhost:3001`. |
| `PORT` | API | Default `3000`. |
| `DRY_RUN_LIMIT` | jobs | Caps the number of items processed. Use for any local run. |
| `PROVIDER` | embed | Optional: only embed resources from one provider. |
| `INSIGHTS_PROVIDER` | insights | `vertexai` (default), `groq` or `gemini`. |
| `GROQ_API_KEY`, `GEMINI_API_KEY` | insights | Only for the `groq` / `gemini` insights providers. |
| `TOP_N`, `CONCURRENCY`, `BATCH_DELAY_MS`, `MAX_CONSECUTIVE_ERRORS` | insights | Batch size and pacing (defaults `20000`, `10`, `200`, `5`). |
| `RESOURCE_ID` | insights | Target one resource in `insights:dry`. |

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | API with hot reload |
| `npm run build` | Type-check and compile to `dist/` |
| `npm start` | Run the compiled API |
| `npm run embed[:dry]` | Embeddings backfill (`:dry` = 20 rows) |
| `npm run insights:dry` / `insights:batch[:dry]` | AI insights for one resource / a batch (`:dry` = 50) |
| `npm run topics:seed`, `npm run onet:seed` | Seed subjects / O*NET occupation data |

## Database migrations

The schema source of truth is `src/db/schema.ts`. After changing it:

```sh
npx drizzle-kit generate   # review the SQL in migrations/
npx drizzle-kit migrate
```

The first migration contains hand-written SQL that Drizzle Kit cannot generate: `CREATE EXTENSION vector`, the HNSW index on `learning_resources.embedding` and the `search_document` tsvector trigger.

To re-run a job for existing resources, reset its column (`embedding` or `ai_insights` on `learning_resources`) to `NULL` and run the job again.

The `runs`, `run_results` and `learning_resources_raw` tables belong to the ingestion pipeline, which is not part of this repository.

## Deployment

The API runs as a Cloud Run service and the jobs as Cloud Run Jobs, all from the same image (`Dockerfile`, `cloudbuild.api.yaml`). See [docs/deployment-gcp.md](docs/deployment-gcp.md).

## License

[MIT](LICENSE)
