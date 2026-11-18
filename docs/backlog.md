# Backlog

Known work for the backend that isn't abuse or cost hardening (that is covered in
[deployment-gcp.md §6](deployment-gcp.md#6-client-ip-and-abuse-limits)). Nothing here is scheduled. Each item says why it matters and, where
it's been looked into, which direction to take. Move an item into a plan of its own when it's picked up.

## Product

### Search quality

*Raised while reviewing search in the abuse-hardening work.* The search was rebuilt: keyword and semantic candidates
merged by rank fusion, typo correction, a weighted rating, the ranking mode in the cursor, bounded cost per query
([search.md](search.md); the problems it started from and the decisions: [search-decisions.md](search-decisions.md)).

What's left needs production data:
- **Tuning and rollout:** the baseline of the previous search, calibrating the evaluation's judge, then the settings in
  `src/search/config.ts`, and performance on the VM. In order: [search.md, "Tuning and rollout"](search.md#tuning-and-rollout).
- **Possible code changes,** if the measurements call for them (broad queries, the distance floor, false typo
  corrections, a quality prior, `lr_is_active_idx`, latency): [search.md](search.md#when-a-measurement-calls-for-a-code-change).
- **Query syntax** (quotes for phrases, `-word` to exclude) isn't supported. Only worth adding if users try it.
- **"free" in a query** is ignored as a generic word. It could set the `is_free` filter instead, as "beginner" could
  set `level`. The search log doesn't record query text, so how often people type such words is unknown. A privacy-safe
  count (e.g. a `level_word` / `free_word` flag in the log line) would tell.

### Product analytics, privacy-first

*Requested during the abuse-hardening work.*

Decisions about features and search need data: how often searches return nothing, which filters and sorts are used,
how deep people page, chat outcomes, and saves and **outbound clicks** per course. Outbound clicks show whether a
recommendation was followed, and nothing tracks them today: course links point straight to the provider.

**Direction:**
- **Question first, counts only:** decide which decisions the data is for, then collect the minimum.
- **Cheapest route:** structured log events (like `chat_answer` and `search`) plus Log Analytics (free), rolled up daily into
  tables like `chat_usage_daily` (counts per day, no identities). The `search` event already gives the zero-result
  rate, filter and sort usage and paging depth ([operations.md §3b](operations.md#3b-search-logs)).
- **Never store raw search text:** people type personal data into search boxes. At most, keep queries that many
  distinct sessions searched on the same day.
- **Outbound clicks** via a small redirect endpoint (e.g. `/go/:resourceId`) that counts and then redirects.
- **Frontend page analytics:** a cookie-free tool (e.g. Cloudflare Web Analytics or self-hosted Umami) avoids a consent
  banner. That's a frontend decision.
- **Privacy policy:** list each addition, with its retention.

## API cleanup

- **Retire legacy MongoDB ids.** Course detail, saved courses and chat page context accept a resource's UUID or its
  CourseCorrect 1.0 MongoDB ObjectId (`learning_resources.legacy_mongo_id`).
  1. Confirm no client still sends them: the Cloud Run request logs for `/api/v1/resources/<24 hex chars>` and
     `/api/v1/saved/<24 hex chars>`. Chat sends ids in the request body, which isn't logged, so consider logging a line
     whenever a legacy id is matched.
  2. Remove `isLegacyMongoId` and update every place tagged `TODO(legacy-mongo-ids)`
     (`grep -rn "legacy-mongo-ids" src test`), including the tests. Announce it in the API changelog.
- **Retire the chat `courseIds` field.** `POST /api/v1/chat` accepts the deprecated `courseIds` name as well as
  `pageContextIds`. Remove it when no client sends it any more (consider logging when it's used), and announce it in the API
  changelog. (This is about the field *name*, not the id format above.)
- **Sort order for saved courses.** `GET /api/v1/saved` returns newest first (it used to be oldest first, contradicting
  its own code comment). Decide whether clients need both orders; if so, add `?sort=newest|oldest`.

## Privacy

- **Account deletion (GDPR right to erasure).** There's no account-deletion flow yet. When one is added, it must delete
  the user's `users` row, their `saved_courses` and their `chat_usage` rows. The daily totals in `chat_usage_daily` hold
  no identities and can stay. `chat_usage` itself is already limited to 7 days by the retention job
  ([operations.md §5](operations.md#5-privacy-and-compliance)).

## Security

- **Refresh tokens can't be revoked.** Backend tokens are stateless JWTs: signing out, removing a sign-in method or
  banning an account takes effect only when the refresh token expires (up to 7 days). A small token version or deny
  list per user would fix it.
- **The Docker image runs as root.** Add a non-root user in the runtime stage of the `Dockerfile`.
- **Security audit.** Run `npm audit` (it couldn't run in the environment where the tests were written). `xlsx@0.18.5`,
  used only by `npm run onet:seed`, is reported to have known vulnerabilities, and fixed versions aren't published on
  npm. Confirm and decide whether to switch libraries or install from the SheetJS CDN.

## Engineering

- **Run tests against real Postgres (Docker) instead of PGlite.** Best practice is to test against the same engine and
  version as production. PGlite is Postgres 17.5 compiled to WebAssembly with pgvector 0.8.0, uses a different database
  driver, and has a single connection. A spike against a real Postgres 16 + pgvector server passed all tests with no
  test-file changes and ran faster (~10s vs ~15s on 4 CPUs with coverage, no per-file startup cost). What's needed:
  1. Use a `pgvector/pgvector:pg<N>` image matching the Cloud SQL Postgres version, with test-speed settings
     (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`). Start it either from the tests via Testcontainers
     (keeps `npm test` a single command, but needs Docker) or with `docker compose up` before `npm test`.
  2. Harness only (about 4 files in `test/`): a global setup that migrates a template database with drizzle's
     postgres-js migrator; per test file, `CREATE DATABASE ... TEMPLATE` and point `DATABASE_URL` at it so the app uses
     its real `src/db/client.ts`; reset tables with `DELETE` inside a transaction using
     `SET LOCAL session_replication_role = replica` (faster than `TRUNCATE`); drop the database after the file.
  3. Add a test step to Cloud Build. Optionally keep PGlite as a no-Docker fallback, selected by an env var such as
     `TEST_DATABASE_URL`.

  This would also cover what PGlite can't: the production database driver, pooled connections and row locks under
  concurrency (the abuse-hardening plan's R5 builds on it).
- **Apply migrations as part of the deploy.** Today they're a manual step before the release
  ([deployment-gcp.md, "Migrations"](deployment-gcp.md#migrations)), which is easy to forget. The common pattern: a
  `migrate` Cloud Run job built from the same image, which Cloud Build runs with `--wait` before deploying the API.
  A failing migration then stops the release before any new code is live. What's needed:
  1. The image includes `migrations/`, plus a small script that uses drizzle's own migrator
     (`drizzle-orm/postgres-js/migrator`), so `drizzle-kit` isn't needed at runtime.
  2. A `migrate` job, created once like the other jobs (same service account, Cloud SQL connection and
     `DATABASE_URL` secret).
  3. A Cloud Build step before the deploy: `gcloud run jobs update migrate --image=...` then
     `gcloud run jobs execute migrate --wait`.
  4. A test that the script applies `migrations/` to an empty database (PGlite) and is a no-op the second time.

  Not recommended: migrating when the API starts (several instances can race, and it ties schema changes to rollbacks).
  The compatibility rules in the deployment guide still apply either way.
- **Major dependency upgrades.** `@google/genai` 2, `@hono/node-server` 2, `firebase-admin` 14 (needs Node 22+) and
  `dotenv` 18 install and pass type-checking and tests. The first three are faked in tests, though, so review their
  release notes and smoke-test against the real services before upgrading.
- **TypeScript 7.** It requires an explicit `"rootDir": "./src"` in `tsconfig.json`. Without it, the build output moves
  to `dist/src/` and `npm start` / the Docker image break.
- **Platform dependencies.** Keep the table in the [README](../README.md#platform-dependencies) up to date when adding
  a Google Cloud or Firebase dependency, so a move stays possible.
