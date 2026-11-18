# CourseCorrect Backend

Backend for [CourseCorrect](https://coursecorrect.fyi), a search and recommendation platform for online courses, programs and degrees.

One TypeScript codebase (Hono + Node.js, ESM) produces two kinds of deployables:

- **API service** (`src/index.ts`, `src/api/`, `src/search/`): REST API with hybrid search (Postgres full-text + pgvector, merged by rank fusion), saved courses, subjects and a streaming AI learning assistant ("Cora").
- **Batch jobs** (`src/jobs/`): enrich the course catalogue with vector embeddings and AI-generated insights, and keep chat usage data to 7 days.

Both share the Drizzle schema in `src/db/schema.ts`.

## Architecture

```
catalogue  learning_resources (+ course_reviews), populated by an ingestion pipeline not included here

embed      resources without embeddings → text-embedding-004 (768d) → pgvector column (halfvec);
           then the search vocabulary (typo correction) is rebuilt
insights   top-rated resources → LLM grounded with O*NET / BLS data → ai_insights JSON
retention  chat_usage older than 7 days → daily totals (chat_usage_daily), then deleted

API        /api/v1/*  search, detail, saved, subjects, chat (SSE)
```

Each job is idempotent, so jobs can be re-run safely: the catalogue jobs work off "what is still NULL" in the
database, and the retention job recomputes its totals.

The API contract (endpoints, request limits, error responses, requirements for clients) is documented in [docs/api.md](docs/api.md). Sign-in methods, and how to add one, are in [docs/auth-providers.md](docs/auth-providers.md). What to remember when running it in production (checks per release, analytics, privacy) is in [docs/operations.md](docs/operations.md), and which alerts, dashboards and spending brakes to set up on Google Cloud (with their cost) in [docs/monitoring.md](docs/monitoring.md).

**Search** merges keyword matches (the trigger-maintained `search_document` tsvector: all words first, then any word) with the nearest neighbours of the embedded query (pgvector HNSW) by reciprocal rank fusion. It corrects typos against a vocabulary of catalogue words, and every sort orders the same results. How it works, its settings and how to tune them: [docs/search.md](docs/search.md); why: [docs/search-decisions.md](docs/search-decisions.md). **Abuse and cost limits** (daily chat limits, per-minute rate limits, input and body caps, sign-in rules) are described for clients in [docs/api.md](docs/api.md#rate-limits) and, for operators, [docs/deployment-gcp.md §6](docs/deployment-gcp.md#6-client-ip-and-abuse-limits). **Chat** streams Gemini responses over SSE, grounded in the resources on the user's current page plus retrieved resources (RAG).

## Project layout

```
src/
  index.ts              API entry point (Hono)
  api/                  routes: auth (+ sign-in rules), resources, saved, subjects, chat (+ input, limits, generation), health;
                        rag.ts; error handler; middleware/ (auth, body limits, client identity, rate limits, proxy check)
  search/               search: config.ts (every tunable value), keyword and semantic candidates, fusion, ordering,
                        cursors, typo correction (docs/search.md)
  db/                   schema.ts (Drizzle), client.ts, seeds/
  lib/                  shared code: embedding client and query cache, client IP, trusted relay, rate limiter,
                        chat_usage retention, structured logger, env and text helpers
  jobs/
    embed.ts            embeddings backfill (then rebuilds the search vocabulary)
    search-vocabulary.ts  rebuilds the search vocabulary on its own
    chat-usage-retention.ts  daily chat_usage retention
    insights/           AI insights (Vertex AI, Groq or Gemini)
    onet/               O*NET / BLS occupation data seed + lookup
migrations/             Drizzle SQL migrations
eval/search/            search quality evaluation on the real catalogue (npm run search:eval; not deployed)
docs/                   API reference, deployment, operations, monitoring and sign-in guides, plans and backlog
```

## Platform dependencies

The API runs on Google Cloud today. To keep a move possible, provider-specific code is kept in a few places:

| Dependency | Used for | Where | What moving would take |
|---|---|---|---|
| Cloud Run | hosting | nothing in code except finding the client IP: `TRUST_PROXY_HOPS`, `src/lib/client-ip.ts` | any container host. Count the proxies in front first ([deployment-gcp.md §6](docs/deployment-gcp.md#revisit-trust_proxy_hops-whenever-the-path-to-the-api-changes), "Move off Cloud Run") |
| Cloud SQL | PostgreSQL + pgvector | `src/db/client.ts` (only the Unix-socket URL form is Cloud SQL-specific) | any PostgreSQL 15+ with pgvector 0.8+ |
| Vertex AI: Gemini 2.5 Flash | chat answers | `src/api/chat.ts`, `src/api/chat-generation.ts` (`@google/genai`) | another model SDK. The output budget (thinking tokens) and usage fields are Gemini-specific |
| Vertex AI: text-embedding-004 | search and chat retrieval | `src/lib/embedding/vertex.ts`; 768 dimensions in the schema and index | another embedding model means **re-embedding the whole catalogue** (and a migration if the dimensions change) |
| Firebase Authentication | sign-in | the login exchange only: `src/api/auth.ts`, `src/api/auth-providers.ts`; user ids are Firebase UIDs | a new login exchange and stable user ids ([auth-providers.md](docs/auth-providers.md#moving-off-firebase-auth)). Everything after login uses the backend's own tokens |
| Cloud Logging, Error Reporting | logs, error grouping | `src/lib/logger.ts` writes JSON lines to stdout. Google-specific: the `severity` field name and the Error Reporting `@type` on error lines | any log collector that reads JSON from stdout (the extra field is harmless) |
| Cloud Build, Artifact Registry, Secret Manager, Cloud Monitoring | build, deploy, secrets, alerts | `cloudbuild.api.yaml`, `docs/deployment-gcp.md`, `docs/monitoring.md` | the `Dockerfile` is portable. The pipeline and monitoring setup would be redone |

The batch jobs' insights provider is already switchable (`INSIGHTS_PROVIDER`: Vertex AI, Groq or Gemini).

## Getting started

Requirements: Node.js 22 (as in the Docker images), PostgreSQL 15+ with the [pgvector](https://github.com/pgvector/pgvector) extension (0.8+), and a Google Cloud project with Vertex AI enabled (for embeddings, extraction and chat).

```sh
npm install
cp .env.example .env     # then fill in the values
npx drizzle-kit migrate  # create the schema
npm run topics:seed      # optional: seed the subject taxonomy (a running API picks it up within 10 minutes)
npm run dev              # API with hot reload on http://localhost:3000 (.env.example sets TRUST_PROXY_HOPS=0 for local use)
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
| `TRUST_PROXY_HOPS` | API | Proxies in front of the API, used to find the visitor's IP. Default `1` (Cloud Run). `0` when nothing is in front (local). **Read [docs/deployment-gcp.md §6](docs/deployment-gcp.md#6-client-ip-and-abuse-limits) before changing what's in front of the API.** |
| `ANON_IP_DAILY_LIMIT` | API | Anonymous chat questions per visitor IP per day, across sessions. Default `20`, `0` = off. |
| `ANON_GLOBAL_DAILY_LIMIT` | API | Anonymous chat questions per day, all visitors together. Default `1000`, `0` = no limit. |
| `CHAT_MODE` | API | Emergency switch for chat: `on` (default), `signed_in_only` or `off`. See [docs/deployment-gcp.md §6](docs/deployment-gcp.md#changing-limits-and-emergency-switches). |
| `SIGNED_IN_GLOBAL_DAILY_LIMIT` | API | Signed-in chat questions per day, all users together. Default `1000`, `0` = no limit. |
| `TRUSTED_RELAY_SECRETS` | API | Secret(s) the Next.js server sends in `X-Relay-Secret` when calling for a visitor (one, or two while rotating; at least 32 characters each). From Secret Manager in production. See [docs/deployment-gcp.md §6](docs/deployment-gcp.md#trusted-relay-the-nextjs-server). |
| `AUTH_ALLOWED_PROVIDERS` | API | Firebase sign-in methods that may log in (e.g. `google.com github.com password`). Default `google.com`. Read [docs/auth-providers.md](docs/auth-providers.md) before adding one. |
| `RATE_LIMIT_MODE` | API | `enforce` (default): requests over a per-minute limit get `429`. `shadow`: only logged. Production starts in `shadow`, see [docs/deployment-gcp.md §6](docs/deployment-gcp.md#rolling-out-the-per-minute-limits-shadow--enforce). |
| `RATE_LIMIT_CHAT_PER_MIN`, `RATE_LIMIT_SEARCH_PER_MIN`, `RATE_LIMIT_LOGIN_PER_MIN`, `RATE_LIMIT_DEFAULT_PER_MIN` | API | Requests per visitor IP per minute: chat `10`, search `60`, login `20`, everything else `120`. `0` = off for that group. |
| `DRY_RUN_LIMIT` | jobs | Caps the number of items processed. Use for any local run. |
| `PROVIDER` | embed | Optional: only embed resources from one provider. |
| `INSIGHTS_PROVIDER` | insights | `vertexai` (default), `groq` or `gemini`. |
| `GROQ_API_KEY`, `GEMINI_API_KEY` | insights | Only for the `groq` / `gemini` insights providers. |
| `TOP_N`, `CONCURRENCY`, `BATCH_DELAY_MS`, `MAX_CONSECUTIVE_ERRORS` | insights | Batch size and pacing (defaults `20000`, `10`, `200`, `5`). |
| `RESOURCE_ID` | insights | Target one resource in `insights:dry`. |
| `CHAT_USAGE_RETENTION_DAYS` | retention | Days of raw `chat_usage` rows to keep. Default `7`, at least `2`. |

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
| `npm run retention:chat-usage` | Summarize completed days into `chat_usage_daily`, delete `chat_usage` rows older than 7 days (a daily job in production) |
| `npm run search:vocabulary` | Rebuild the search vocabulary (typo correction); the embed job also does it |
| `npm run search:eval` | Evaluate search quality on a copy of the catalogue ([eval/search/README.md](eval/search/README.md)) |

## Testing

```sh
npm test               # run the whole suite once (no database, credentials or network needed)
npm run test:watch     # re-run on file changes
npm run test:coverage  # also writes an HTML report to coverage/index.html
npm run typecheck      # type-check src/, test/ and eval/ (Vitest runs tests without type-checking)
```

The suite covers the API (`src/index.ts`, `src/api/`), search (`src/search/`: golden queries in `test/api/search-golden.test.ts`, each step and the query plans in `test/search/`), the shared code in `src/lib/` (including the embedding client), the halfvec migration (`test/db/`), the retention and vocabulary jobs, and the search evaluation harness (`test/eval/`). Every production dependency is replaced with an in-process fake in `test/setup.ts`:

| Production | In tests |
|---|---|
| Postgres + pgvector, pg_trgm, fuzzystrmatch | [PGlite](https://pglite.dev) (Postgres compiled to WASM, with the same extensions), schema built from `migrations/*.sql`, emptied before each test |
| Vertex AI embeddings | `test/fakes/embedding.ts`: controllable `embedQuery()` |
| Gemini (`@google/genai`) | `test/fakes/genai.ts`: scripted streaming replies |
| Firebase Admin | `test/fakes/firebase.ts`: tokens registered per test |
| `@hono/node-server` | `test/fakes/node-server.ts`: records the fetch handler; no port is opened |
| `.env` / network | `dotenv/config` is a no-op and global `fetch` throws |

In-memory per-instance state (rate-limit buckets, caches, once-a-minute log windows) is cleared before each test, like the database. The app's structured log lines are hidden from the test output; run with `TEST_LOGS=1` to see them. One test file also runs the retention job as a real process (no fakes, no database) to check its entry point and exit code.

Search, pagination, upserts and daily chat limits run real SQL against PGlite, so the tests also check the hand-written parts of the migrations (pgvector, the `search_document` trigger). Each test file gets its own database. A migrated snapshot is built once and cached in the OS temp dir, keyed by the migration files, so it is rebuilt automatically when the schema changes.

Tests describe the *correct* behaviour. A known bug that hasn't been fixed yet is written as `it.fails(...)` with a `KNOWN BUG` comment: it runs on every build and reports "expected fail". When the bug is fixed, the test starts failing, which reminds you to change it to `it(...)`. Run `grep -rn "KNOWN BUG" test/` to list them.

Tests must give the same result on every run. Where an order has ties (broken by random UUIDs) or a plan depends on table size, the tests use fixed ids, compare against an order computed from the ids, or say why they're exact: see [docs/search.md, Tests](docs/search.md#tests) for the search tests.

## Database migrations

The schema source of truth is `src/db/schema.ts`. After changing it:

```sh
npx drizzle-kit generate   # review the SQL in migrations/
npx drizzle-kit migrate
```

In production, migrations are applied by hand before the release that needs them: the deploy doesn't run them. Each
migration must keep working with the version that's still running. Procedure and rules:
[docs/deployment-gcp.md, "Migrations"](docs/deployment-gcp.md#migrations).

The first migration contains hand-written SQL that Drizzle Kit cannot generate: `CREATE EXTENSION vector` and the `search_document` tsvector trigger (and an HNSW index, which `0007` replaced with one declared in the schema). `0007` stores embeddings as `halfvec`; it rewrites the table, so read [its notes](docs/deployment-gcp.md#the-halfvec-migration-0007) before applying it to a database in use. `0008` adds hand-written `CREATE EXTENSION` lines (`pg_trgm`, `fuzzystrmatch`) before the generated vocabulary table; fill the table afterwards with `npm run search:vocabulary` ([notes](docs/deployment-gcp.md#the-search-vocabulary-0008)).

To re-run a job for existing resources, reset its column (`embedding` or `ai_insights` on `learning_resources`) to `NULL` and run the job again.

The `runs`, `run_results` and `learning_resources_raw` tables belong to the ingestion pipeline, which is not part of this repository.

## Deployment

The API runs as a Cloud Run service and the jobs as Cloud Run Jobs, all from the same image (`Dockerfile`, `cloudbuild.api.yaml`). See [docs/deployment-gcp.md](docs/deployment-gcp.md).

## To do

- [ ] **Abuse and cost hardening release:** follow [docs/operations.md](docs/operations.md#first-release-of-the-hardening-changes-one-time), then switch the per-minute limits from shadow to enforce ([docs/deployment-gcp.md §6](docs/deployment-gcp.md#rolling-out-the-per-minute-limits-shadow--enforce)). Client-visible changes are in the [API changelog](docs/api.md#changelog).
- [ ] **Everything else** (search quality, analytics, API cleanup, privacy, security, engineering): [docs/backlog.md](docs/backlog.md).

## License

[MIT](LICENSE)
