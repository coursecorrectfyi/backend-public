# CourseCorrect API reference

This is the contract between this backend and its clients (the CourseCorrect frontend). If code and this document
disagree, that's a bug: fix whichever one is wrong. Changes that affect clients are listed in the
[Changelog](#changelog).

**Frontend developers:** start with the [Frontend alignment checklist](#frontend-alignment-checklist). It lists what
the frontend still needs to change to match this contract, in order of priority.

## Conventions

- **Base path:** `/api/v1` (except `/health`). Request and response bodies are JSON unless stated otherwise.
- **Errors:** a JSON object with an `error` string, e.g. `{ "error": "Not found" }`. Some errors add fields
  (documented per endpoint). Server errors never include internal details.
- **Authentication:** endpoints marked *access token* need `Authorization: Bearer <token>`, using the `token`
  from [login](#post-apiv1authfirebaselogin) or [refresh](#post-apiv1authrefresh). Failures return `401`
  with one of `Missing or malformed Authorization header`, `Invalid token type` or `Invalid or expired token`.
- **Resource ids:** a resource is identified by its UUID. Legacy CourseCorrect 1.0 MongoDB ids (24 hex characters) are
  still accepted wherever a resource id is accepted, but are deprecated.
- **CORS:** only origins in `ALLOWED_ORIGINS` get CORS headers. Allowed request headers are `Content-Type`,
  `Authorization` and `X-Session-ID`. Response headers readable by frontend code: the CORS-safelisted ones
  (`Content-Type`, `Cache-Control`, ...) plus `Retry-After`. Any other response header is hidden from frontend code by the
  browser, so a new header meant for the frontend must be added to `exposeHeaders` in `src/index.ts`.
- **Per-visitor limits** are keyed on the IP address the request comes from. Endpoints marked **browser only** must be
  called directly from the visitor's browser: a request relayed through the Next.js server carries the server's IP, so
  all visitors would share one limit. Browser only today: `POST /api/v1/chat`.
- **`429` responses** always include a `Retry-After` header: seconds until the limit resets, readable by frontend code.
- **Text lengths** are measured like JavaScript's `String.length` (UTF-16 code units), the same unit as the HTML `maxlength`
  attribute. A frontend field with `maxLength={N}` can never exceed a backend limit of `N`.

### Request body size

Request bodies over the limit are rejected before they are parsed:

| Route | Limit |
|---|---|
| `POST /api/v1/chat` | 512 KB (524,288 bytes) |
| Every other route | 16 KB (16,384 bytes) |

Response: `413 { "error": "Request body too large", "maxBytes": <limit> }`.

## Health

### `GET /health`
`200 { "status": "ok" }`, or `503 { "status": "error", "message": "Database unavailable" }`.

## Auth

### `POST /api/v1/auth/firebase/login`
Exchanges a Firebase ID token for backend tokens and creates or updates the user.

Body: `{ "idToken": string }`

| Status | Body |
|---|---|
| 200 | `{ token, refreshToken, tokenExpires, user }`. `token` expires after 1 hour, `refreshToken` after 7 days. `tokenExpires` is the access token expiry in **milliseconds** since the epoch. `user` is `{ id, email, provider: "google", socialId, firstName, lastName, role: { id: 1 }, status: { id: 1 }, createdAt, updatedAt }` |
| 400 | `{ "error": "idToken is required" }` |
| 401 | `{ "error": "Invalid Firebase ID token" }` |

### `POST /api/v1/auth/refresh`
Header: `Authorization: Bearer <refreshToken>`. Returns a new pair: `200 { token, refreshToken, tokenExpires }`.
`401` for a missing header, an invalid or expired token, or an access token sent instead of a refresh token.

### `POST /api/v1/auth/logout`
`200 { "ok": true }`. Tokens are stateless; the client discards them.

## Resources

### `GET /api/v1/resources/search`
Hybrid full-text + semantic search over active resources.

| Query parameter | Description |
|---|---|
| `q` | **Required.** Plain-text query. Missing or blank gives `400 { "error": "Missing required query parameter: q" }` |
| `limit` | Page size, default 20, clamped to 1–50 |
| `sort` | `relevance` (default), `rating`, `most_reviewed`, `duration_asc`, `duration_desc`, `newest` |
| `cursor` | `next_cursor` from the previous page. Send it back unchanged, with the same `q`, `sort` and filters |
| `level`, `provider`, `language`, `resource_type` | Filters, repeatable (`?level=beginner&level=advanced`) |
| `is_free`, `has_certificate` | `true` or `false`. Other values are ignored |

`200 { data, next_cursor, vector_search }`:
- `data`: resources with `id, provider, resource_type, provider_type, title, ai_summary, institution, language,
  level, duration_hours, rating, num_ratings, is_free, has_certificate, is_self_paced, skills, career_paths, url`.
- `next_cursor`: string, or `null` on the last page.
- `vector_search`: `false` when semantic ranking was unavailable and results are keyword-only.

### `GET /api/v1/resources/:id`
One active resource: the search fields plus `external_id, legacy_mongo_id, ai_insights, ai_insights_updated_at,
last_normalized_at`. `404 { "error": "Not found" }` if the id is unknown, malformed or inactive.

## Saved courses (*access token*)

### `GET /api/v1/saved`
`200 { data }`: the user's saved active resources, newest first, with the search fields plus `saved_at`.

### `POST /api/v1/saved/:resourceId`
Saves a resource. Idempotent. `200 { "ok": true }`, or `404 { "error": "Resource not found" }`.

### `DELETE /api/v1/saved/:resourceId`
Removes a saved resource. Idempotent, always `200 { "ok": true }`.

## Subjects

### `GET /api/v1/subjects`
`200`: flat array of topics `{ id, name, slug, description, meta_description, parent_id, sort_order, course_count }`,
each domain followed by its subtopics.

### `GET /api/v1/subjects/tree`
`200 { domains }`: each domain with a `subtopics` array.

### `GET /api/v1/subjects/:slug`
Domain: `200 { topic, subtopics }`. Subtopic: `200 { topic, parent }`. Unknown slug: `404 { "error": "Not found" }`.

## Chat (Cora)

### `POST /api/v1/chat` (browser only)
Answers a question about courses, grounded in the resources on the user's page and the catalogue. The answer is
streamed as Server-Sent Events.

> **Call this endpoint from the browser, never from the Next.js server.** Anonymous limits are counted per
> visitor IP. Requests relayed through the frontend server would all carry the server's IP, so every visitor would share
> one limit of 20 anonymous questions a day.

**Identity** (one is required):

| Header | Who |
|---|---|
| `Authorization: Bearer <token>` | signed-in user (valid access token) |
| `X-Session-ID: <uuid>` | anonymous visitor |

- If both are sent, a valid token wins. If the token is invalid or expired, the session id is used instead.
- `X-Session-ID` must be a UUID (any case, surrounding whitespace ignored). Generate it once with
  `crypto.randomUUID()`, keep it in `localStorage` and reuse it. Don't make a new one when a limit is reached, because that
  doesn't get around the per-network limit below.

**Daily limits.** They reset at midnight UTC. A question counts once it's accepted, and is given back if the answer
fails before any text is streamed.

| Who | Limit | 429 `message` |
|---|---|---|
| Signed-in user | 10 questions per user | `You've used all 10 of your daily questions. Your limit resets at midnight UTC.` |
| Anonymous, per session | 5 questions per `X-Session-ID` | `You've used all 5 of your daily questions. Sign in to get 10 questions per day.` |
| Anonymous, per network | 20 questions per visitor IP (IPv6: per /64), across all sessions | `Too many questions from your network today. Sign in to get 10 questions per day.` |
| Anonymous, everyone | a daily total for all anonymous visitors together | `Cora has reached today's limit for guest questions. Sign in to get 10 questions per day.` |

The per-network and global numbers are deployment settings (defaults 20 and 1,000), so don't hardcode them in the
frontend. Show the 429 `message` as is. Every anonymous limit message suggests signing in, and signed-in users are only
subject to their own limit of 10.

**Body:**

| Field | Type | Required | Limit | Over the limit |
|---|---|---|---|---|
| `message` | string | yes | 4,000 characters, after trimming surrounding whitespace | **`400`** (see below) |
| `history` | `Array<{ role: "user" \| "bot", content: string }>` oldest first | no | most recent **20** turns, each up to **16,000** characters, **32,000** characters in total | Older turns are dropped and long turns are cut. If older turns are dropped, the kept turns start with a `user` turn |
| `pageContextIds` | string[] (resource ids) | no | first **50** distinct, well-formed ids | Extra ids are ignored. Malformed ids and duplicates are ignored and don't count toward the 50 |
| `courseIds` | string[] | no | as `pageContextIds` | **Deprecated** alias, used only when `pageContextIds` is absent |
| `currentPage` | `"SearchResult"` \| `"SavedCourses"` \| `"CourseDetail"` \| `"SubjectPage"` | no | — | Unknown values are treated as `"SearchResult"` (the default) |
| `searchTerm` | string | no | 200 characters | Cut. Whitespace and line breaks are collapsed into single spaces |

Malformed `history` entries and fields of the wrong type are ignored.

**Responses:**

| Status | Body | Counts toward the daily limit? |
|---|---|---|
| 200 | SSE stream (below) | yes, unless generation fails or times out before any answer text is produced. A question still counts if the client disconnects early |
| 400 | `{ "error": "Invalid JSON body" }` | no |
| 400 | `{ "error": "message is required" }` | no |
| 400 | `{ "error": "message must be at most 4000 characters", "maxLength": 4000 }` | no |
| 400 | `{ "error": "Provide Authorization: Bearer <token> or X-Session-ID header" }` | no |
| 400 | `{ "error": "X-Session-ID must be a UUID" }` (no valid token, and the session id isn't a UUID) | no |
| 413 | `{ "error": "Request body too large", "maxBytes": 524288 }` | no |
| 429 | `{ "limitReached": true, "message": "<text to show the user>" }` plus a `Retry-After` header (seconds until midnight UTC) | no |

**Stream events** (each `data:` line is JSON):

| Event | Meaning |
|---|---|
| `{ "type": "delta", "content": "..." }` | Next piece of the answer (Markdown). Append to the message |
| `{ "type": "done" }` | Answer complete |
| `{ "type": "done", "truncated": true }` | Answer complete but cut short at the length limit. The last `delta` before it is a short note telling the user to ask Cora to continue, so nothing extra needs to be shown |
| `{ "type": "error", "message": "..." }` | Generation failed or took too long (over 2 minutes). Show `message`. If no `delta` arrived, the question wasn't counted |

**Answer length:** answers are limited to about 4,096 tokens, roughly 12,000–16,000 characters of Markdown. That's enough for a
comparison table of 10 courses with links plus pros and cons for each. Answers longer than that are cut short, as described above.

**Closing the connection** (navigating away, aborting the `fetch`) stops the answer. The question still counts, because
the model already started working on it.

## Frontend alignment checklist

What the frontend needs to change to match this contract, in order of priority. Each item says what happens with the
current frontend if it isn't done yet. The backend was built to keep working with the current frontend, so nothing here
is an outage, but the items in **Should do** can give users a confusing experience.

### Should do (users can see the problem today)

- [ ] **Chat `429` banner.** *Today:* any chat `429` shows `message` as a bot reply, locks the input, and shows the fixed
      banner "You've used your free questions for today...". The backend now has four daily limits with different
      messages (see [Daily limits](#post-apiv1chat-browser-only)), e.g. *"Too many questions from your network today.
      Sign in..."*. The fixed banner contradicts those, especially for a first-time visitor on a shared network.
      *Change:* show the response `message` in the banner (or use neutral wording), and keep offering sign-in to
      anonymous users. Locking the input is still right: every chat `429` today is a daily limit.
      `Retry-After` (seconds until midnight UTC) can be used to show when it resets.
- [ ] **Chat message length.** *Today:* no limit in the input. A message over 4,000 characters now gets
      `400 { error, maxLength }`, which the frontend probably shows as a generic failure. *Change:* `maxLength={4000}` on
      the input (same unit as the backend, so they always agree), ideally with a counter near the limit. Show `error` on `400`.
- [ ] **`413` on chat.** Only with an extremely long `history` (request body over 512 KB). *Change:* show a readable
      message, or avoid it entirely with the next item.

### Recommended (smaller requests, less wasted work)

- [ ] Send at most the **last 20 turns** of `history`. The backend uses only those anyway.
- [ ] Send at most **50 `pageContextIds`** (e.g. the saved courses page with many saved items). Extra ids are ignored.
- [ ] Send **`pageContextIds`** instead of the deprecated `courseIds`.
- [ ] **Abort the chat `fetch`** (an `AbortController`) when the user leaves the chat or the page, so the server stops
      working on an answer nobody will read.
- [ ] Optional: use **`truncated: true`** on `done`, e.g. a "Continue" button that sends "Please continue". The note
      in the last `delta` already tells the user, so this isn't required.
- [ ] **Saved courses order:** `GET /api/v1/saved` now returns newest first (it used to be oldest first). Check whether the
      frontend re-sorts or reverses it (see "Frontend: saved courses order" in the README To do list).

### Keep as is (already correct, must not regress)

- [x] `X-Session-ID` is one `crypto.randomUUID()`, kept in `localStorage` (`cc_session_id`) and reused. Don't make a new one
      when a limit is reached. It must stay a UUID (other values get `400`).
- [x] `POST /api/v1/chat` is called **from the browser**, never through the Next.js server (see the note at the top of Chat).

### Coming later (not live yet)

Planned backend changes that will need frontend work when they ship:
- Per-minute rate limits on browser-called routes, with a new `429` body (`code: "rate_limited"`, `retryAfter`).
  On chat that kind of `429` must **not** lock the input.
- The Next.js server sending a credential and the visitor's IP on its server-side API calls.

## Changelog

### Unreleased
- **Request body limits:** 512 KB for `POST /api/v1/chat`, 16 KB for every other route. Larger bodies get `413`.
- **`POST /api/v1/chat` input limits:** `message` over 4,000 characters now returns `400` with `maxLength`. (It was previously
  unlimited.) `history`, `pageContextIds`, `courseIds` and `searchTerm` are now bounded (extra content is dropped quietly,
  see the table above). Unknown `currentPage` values are now treated as `SearchResult`.
- **`POST /api/v1/chat` anonymous limits:** `X-Session-ID` must be a UUID (`400` otherwise) and is case-insensitive.
  New limits across sessions: 20 anonymous questions per visitor IP per day, and a global daily total for
  anonymous questions, each with its own `429` message. Every chat `429` now includes `Retry-After`.
- **`POST /api/v1/chat` answers:** limited to about 4,096 tokens of visible text. If an answer hits the limit, a note is streamed
  and `done` carries `truncated: true`. Generation stops after 2 minutes with an `error` event. `history` turns may be up to
  16,000 characters (was 8,000) so long answers are sent back whole. A question counts even if the client disconnects.
- **CORS:** `Retry-After` is now exposed, so frontend code can read it (before, the browser hid it even though it was sent).
