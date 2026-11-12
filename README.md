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
| `npm test` | Run the test suite (see [Testing](#testing)) |
| `npm run embed[:dry]` | Embeddings backfill (`:dry` = 20 rows) |
| `npm run insights:dry` / `insights:batch[:dry]` | AI insights for one resource / a batch (`:dry` = 50) |
| `npm run topics:seed`, `npm run onet:seed` | Seed subjects / O*NET occupation data |

## Testing

```sh
npm test               # run the whole suite once (no database, credentials or network needed)
npm run test:watch     # re-run on file changes
npm run test:coverage  # also writes an HTML report to coverage/index.html
npm run typecheck      # type-check src/ and test/ (Vitest runs tests without type-checking)
```

The suite covers the API (`src/index.ts`, `src/api/`) and the embedding client (`src/lib/embedding/vertex.ts`). Every production dependency is replaced with an in-process fake in `test/setup.ts`:

| Production | In tests |
|---|---|
| Postgres + pgvector | [PGlite](https://pglite.dev) (Postgres compiled to WASM, with pgvector), schema built from `migrations/*.sql`, emptied before each test |
| Vertex AI embeddings | `test/fakes/embedding.ts`: controllable `embedQuery()` |
| Gemini (`@google/genai`) | `test/fakes/genai.ts`: scripted streaming replies |
| Firebase Admin | `test/fakes/firebase.ts`: tokens registered per test |
| `@hono/node-server` | `test/fakes/node-server.ts`: records the fetch handler; no port is opened |
| `.env` / network | `dotenv/config` is a no-op and global `fetch` throws |

Search, pagination, upserts and daily chat limits run real SQL against PGlite, so the tests also check the hand-written parts of the migrations (pgvector, the `search_document` trigger). Each test file gets its own database. A migrated snapshot is built once and cached in the OS temp dir, keyed by the migration files, so it is rebuilt automatically when the schema changes.

Tests describe the *correct* behaviour. A known bug that hasn't been fixed yet is written as `it.fails(...)` with a `KNOWN BUG` comment: it runs on every build and reports "expected fail". When the bug is fixed, the test starts failing, which reminds you to change it to `it(...)`. Run `grep -rn "KNOWN BUG" test/` to list them.

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

## To do

- [ ] **Retire legacy MongoDB ids.** Course detail, saved courses and chat page context accept a resource's UUID or its CourseCorrect 1.0 MongoDB ObjectId (`learning_resources.legacy_mongo_id`).
  1. Confirm no client still sends legacy ids: check the frontend, and the Cloud Run request logs for `/api/v1/resources/<24 hex chars>` and `/api/v1/saved/<24 hex chars>`. Chat sends ids in the request body, which isn't logged, so consider logging a line whenever a legacy id is matched.
  2. Remove `isLegacyMongoId` and update every place tagged `TODO(legacy-mongo-ids)` (`grep -rn "legacy-mongo-ids" src test`), including the tests.
- [ ] **Retire the chat `courseIds` field.** `POST /api/v1/chat` accepts the legacy `courseIds` field name as well as `pageContextIds`. Remove it once the frontend only sends `pageContextIds`. (This is about the field *name*, not the id format above.)
- [ ] **Frontend: saved courses order.** `GET /api/v1/saved` now returns newest first. It used to return oldest first, contradicting its own code comment. When working on the frontend, check whether it re-sorts or reverses the list, then decide between using the API order as is and adding a sort option (e.g. `?sort=newest|oldest`) for both orders.
- [ ] **Retention and cleanup for `chat_usage`.** Nothing deletes from this table, so it grows by one row per person per day of chat use (roughly 150–200 bytes per row with indexes). The daily limit only needs today's row; keep at least the previous day too, because a question held just before midnight is given back to that day's row. Lookups stay fast as the table grows, so this is about storage and privacy, not performance.
  - **GDPR:** `identity` holds a Firebase UID for signed-in users and a browser-generated session id for anonymous users. Both are likely personal data: pseudonymous identifiers that can be linked to a person or device. Keeping them indefinitely conflicts with the storage-limitation and data-minimisation principles (Art. 5(1)(e) and 5(1)(c)). Decide and document a retention period, reflect it in the privacy policy, and make sure deleting a user's account also deletes their rows (right to erasure, Art. 17; no account-deletion flow exists in this API yet). Confirm the details with whoever owns privacy/legal.
  - **Decide:** the retention period, and whether to store aggregated, anonymised analytics before purging. For example, a daily summary table (date, `identity_type`, distinct users, questions) with no identities. Truly aggregated counts are not personal data, but avoid very small groups that could single someone out.
  - **Implementation options:**
    - *Recommended:* a daily Cloud Run Job plus Cloud Scheduler, following the `insights-batch` pattern in `docs/deployment-gcp.md`, that (optionally) writes the summary and then runs `DELETE FROM chat_usage WHERE query_date < CURRENT_DATE - <retention>`. The existing `chat_usage_date_idx` index keeps this cheap, and the job can be covered by the test suite.
    - *Alternative:* `pg_cron` in Cloud SQL. There's no app code, but the schedule lives in database config and is hard to test.
- [ ] **Run tests against real Postgres (Docker) instead of PGlite.** Best practice is to test against the same engine and version as production. PGlite is Postgres 17.5 compiled to WebAssembly with pgvector 0.8.0, uses a different database driver, and has a single connection. A spike against a real Postgres 16 + pgvector server passed all tests with no test-file changes and ran faster (~10s vs ~15s on 4 CPUs with coverage, no per-file startup cost). What's needed:
  1. Use a `pgvector/pgvector:pg<N>` image matching the Cloud SQL Postgres version, with test-speed settings (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`). Start it either from the tests via Testcontainers (keeps `npm test` a single command, but needs Docker) or with `docker compose up` before `npm test`.
  2. Harness only (about 4 files in `test/`): a global setup that migrates a template database with drizzle's postgres-js migrator; per test file, `CREATE DATABASE ... TEMPLATE` and point `DATABASE_URL` at it so the app uses its real `src/db/client.ts`; reset tables with `DELETE` inside a transaction using `SET LOCAL session_replication_role = replica` (faster than `TRUNCATE`); drop the database after the file.
  3. Add a test step to Cloud Build. Optionally keep PGlite as a no-Docker fallback, selected by an env var such as `TEST_DATABASE_URL`.
- [ ] **Major dependency upgrades.** `@google/genai` 2, `@hono/node-server` 2, `firebase-admin` 14 (needs Node 22+) and `dotenv` 18 install and pass type-checking and tests. The first three are faked in tests, though, so review their release notes and smoke-test against the real services in staging before upgrading.
- [ ] **TypeScript 7.** It requires an explicit `"rootDir": "./src"` in `tsconfig.json`. Without it, the build output moves to `dist/src/` and `npm start` / the Docker image break.
- [ ] **Security audit.** Run `npm audit` (it couldn't run in the environment where the tests were written). `xlsx@0.18.5`, used only by `npm run onet:seed`, is reported to have known vulnerabilities, and fixed versions aren't published on npm. Confirm and decide whether to switch libraries or install from the SheetJS CDN.

## License

[MIT](LICENSE)
