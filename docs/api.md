# CourseCorrect API reference

The contract of the CourseCorrect backend API: every endpoint, what it accepts, what it returns, its limits, and what
it requires from clients. It describes this API only. Whether a particular client follows it is that client's concern.
If the API and this document disagree, that's a bug in the backend: fix whichever one is wrong.

This document is complete on its own: a client can be checked against it without knowing anything about the API's
history or about other clients. The [Changelog](#changelog) only records how the API itself changed over time, and is
no substitute for reading the contract.

## Conventions

- **Base path:** `/api/v1` (except `/health`). Request and response bodies are JSON unless stated otherwise.
- **Errors:** a JSON object with an `error` string, e.g. `{ "error": "Not found" }`. Some errors add fields, documented
  per endpoint, most often a machine-readable `code`. Errors never include internal details.
- **Server errors:** an unexpected failure returns `500 { "error": "Internal server error" }`. Any endpoint can also
  return `500` with another `error` (e.g. `Server configuration error`). Treat every `5xx` as a temporary server
  problem, never as a reason to sign the user out.
- **Authentication:** endpoints marked *access token* need `Authorization: Bearer <token>`, using the `token` from
  [login](#post-apiv1authfirebaselogin) or [refresh](#post-apiv1authrefresh). Failures return `401` with one of
  `Missing or malformed Authorization header`, `Invalid token type` or `Invalid or expired token`.
- **Resource ids:** a resource is identified by its UUID. Legacy CourseCorrect 1.0 MongoDB ids (24 hex characters) are
  still accepted wherever a resource id is accepted, but are **deprecated**.
- **CORS:** only the deployment's configured origins get CORS headers. Allowed methods: `GET`, `POST`, `DELETE`,
  `OPTIONS`. Allowed request headers: `Content-Type`, `Authorization`, `X-Session-ID`. Response headers readable by
  browser code: the CORS-safelisted ones (`Content-Type`, `Cache-Control`, ...) plus `Retry-After`. The relay headers
  (`X-Relay-Secret`, `X-Visitor-IP`) are deliberately not allowed: only servers send them.
- **Per-visitor limits** are keyed on the visitor's IP address (IPv6: per /64): the address a request comes from, or,
  for [calls a trusted server makes for a visitor](#calls-from-a-server-on-a-visitors-behalf), the address it names.
- **Text lengths** are measured like JavaScript's `String.length` (UTF-16 code units), the same unit as the HTML
  `maxlength` attribute: an input with `maxlength` N can never exceed a limit of N here.
- **Deployment settings:** some numbers below (per-minute budgets, some daily limits, accepted sign-in methods) are
  deployment settings. The documented values are the defaults. Clients shouldn't hardcode them: use `message`,
  `retryAfter` and `code` from the responses.

## Requirements for clients

What a client must do for the limits and identities below to work as documented:

1. **A server calling the API for a visitor must say which visitor**, on every such call, to every endpoint:
   see [Calls from a server on a visitor's behalf](#calls-from-a-server-on-a-visitors-behalf). Without it, the call
   counts as the server's own, and all of the server's visitors share one set of limits (for example, 20 logins a
   minute for everyone).
2. **`X-Session-ID` is one UUID per browser, kept and reused** (see [Chat identity](#post-apiv1chat)): generate it
   once with `crypto.randomUUID()`, store it (e.g. in `localStorage`), and send the same value on every chat request.
   Don't replace it when a limit is reached. Anything but a UUID gets `400`.
3. **Handle every `429`** on every endpoint that can return it ([429 responses](#429-responses)). Use `code` to tell
   a temporary rate limit from a daily limit. On chat, also handle `503` with `code` `chat_unavailable` or
   `chat_signed_in_only` ([Chat](#post-apiv1chat)): chat can be switched off, entirely or for guests.
4. **Respect the input limits** ([request body size](#request-body-size), [chat body](#post-apiv1chat)). Oversized
   input is rejected or cut, as documented per field.
5. **Sign-in:** only send a Firebase ID token from an accepted sign-in method, and for email/password, only after the
   email address is verified ([login](#post-apiv1authfirebaselogin)).

### Calls from a server on a visitor's behalf

Any endpoint can be called either from the visitor's browser or from a server acting for the visitor (e.g. a frontend's
server-side rendering). A server doing that is a **relay**, and sends two extra headers on every such call:

| Header | Value |
|---|---|
| `X-Relay-Secret` | the shared secret, agreed with the API's operators (`TRUSTED_RELAY_SECRETS` on the API side) |
| `X-Visitor-IP` | the visitor's IP address: exactly one address, IPv4 or IPv6 |

- **Which address:** the address the relay's own platform saw the visitor connect from. Behind a proxy, that's the
  entry the proxy appended, never one the visitor could have written. On Cloud Run: the **last** entry of the incoming
  `X-Forwarded-For` header. The first entries are whatever the visitor's client sent, and trusting them would let anyone
  choose their own identity. Never pass on an `X-Visitor-IP` or `X-Forwarded-For` value received from the browser.
- **The secret stays on the server.** It must never reach browser code, for example through a public environment
  variable, an environment value inlined into the client bundle, props passed to client components, or logs of request
  headers. Whoever has it can claim any visitor IP and get around every per-visitor limit.
- **With a valid secret and address,** the call counts as that visitor, exactly like the visitor's own browser
  calling. **Without the headers, or with a wrong secret or an invalid address,** the call still works, but counts as
  the relay's own IP: all of its visitors share one set of limits. The API reports wrong secrets and addresses to its
  operators.
- The API can accept two secrets at once, so the secret can be rotated without downtime: the relay switches to the
  new one at any point while both are accepted.

### Request body size

Request bodies over the limit are rejected before they are parsed:

| Route | Limit |
|---|---|
| `POST /api/v1/chat` | 512 KB (524,288 bytes) |
| Every other route | 16 KB (16,384 bytes) |

Response: `413 { "error": "Request body too large", "maxBytes": <limit> }`.

### Rate limits

Requests per visitor IP (IPv6: per /64) per minute, per group of routes:

| Group | Routes | Per minute |
|---|---|---|
| chat | `POST /api/v1/chat` | 10 |
| search | `GET /api/v1/resources/search` | 60 |
| login | `POST /api/v1/auth/firebase/login` | 20 |
| everything else | `GET /api/v1/resources/:id`, `/api/v1/subjects*`, `/api/v1/saved*`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `/health`, unknown paths | 120, shared by these routes |
| not limited | CORS preflights (`OPTIONS`) | — |

- A visitor can send a whole minute's budget at once, then one request every 60/N seconds (a token bucket).
- Requests over the limit get [`429` with `code: "rate_limited"`](#429-responses) and have no effect. For example, a
  chat request over the limit doesn't use up a daily question.
- Limits are per visitor wherever the call comes from: a visitor's browser calls and the relayed calls made for them
  share one budget.
- Whether the limits are enforced is a deployment setting. A client must handle `rate_limited` on every route at any time.

### 429 responses

Every `429` has a `Retry-After` header (seconds) and this body:

| Field | Rate limit (per minute) | Daily chat limit |
|---|---|---|
| `error` | `"Too many requests"` | `"Daily limit reached"` |
| `code` | `"rate_limited"` | `"daily_limit"` |
| `message` | `"Too many requests. Please wait a moment and try again."` | depends on the limit, see [Chat](#post-apiv1chat) |
| `retryAfter` | seconds until the next request is allowed (usually a few) | seconds until midnight UTC |
| `limitReached` | `false` | `true` |
| `scope` | — | `"user"`, `"session"`, `"ip"`, `"global"` or `"signed_in_global"` |

- **`rate_limited`** is temporary. The same request succeeds after `retryAfter` seconds. It is never a daily limit.
- **`daily_limit`** means no more chat questions for this identity (or for everyone in the group, see `scope`) until
  midnight UTC. `message` is written for the end user.
- `limitReached` carries the same information as `code` and is kept for compatibility. Prefer `code`.

## Health

### `GET /health`
`200 { "status": "ok" }`, or `503 { "status": "error", "message": "Database unavailable" }`. The database check is
cached for up to 5 seconds and answers within about 3 seconds, even when the database hangs.

## Auth

### `POST /api/v1/auth/firebase/login`
Exchanges a Firebase ID token for backend tokens, and creates or updates the user.

Body: `{ "idToken": string }`

**Accepted sign-in methods** are a deployment setting (default: **Google only**). For email/password accounts, the
email address must be verified before login. Firebase marks it verified once the user follows the verification link.

| Status | Body |
|---|---|
| 200 | `{ token, refreshToken, tokenExpires, user }` (below) |
| 400 | `{ "error": "idToken is required" }` |
| 401 | `{ "error": "Invalid Firebase ID token" }` (invalid, expired or forged) |
| 403 | `{ "error": "This sign-in method is not supported", "code": "provider_not_allowed" }`. No user is created |
| 403 | `{ "error": "Verify your email address before signing in", "code": "email_not_verified" }`: email/password account whose email isn't verified yet. No user is created. Log in again after verification (with a fresh ID token, since the verified status is part of the token) |
| 413, 429 | see [Request body size](#request-body-size), [429 responses](#429-responses) (login group) |

`200` body:
- `token`: access token, expires after 1 hour. `refreshToken`: expires after 7 days. `tokenExpires`: the access token
  expiry in **milliseconds** since the epoch.
- `user`: `{ id, email, provider, socialId, firstName, lastName, role: { id: 1 }, status: { id: 1 }, createdAt, updatedAt }`
  - `id` and `socialId`: the Firebase UID.
  - `email`, `firstName`, `lastName`: may be `null` (not every sign-in method provides a name or an email).
  - `provider`: the sign-in method: `"google"`, `"apple"`, `"microsoft"`, `"github"`, `"facebook"`, `"twitter"`,
    `"yahoo"`, `"email"` (email/password and email link), `"phone"`, or `"oidc.<name>"` / `"saml.<name>"`. Only
    accepted methods can appear.

### `POST /api/v1/auth/refresh`
Header: `Authorization: Bearer <refreshToken>`. Returns a new pair: `200 { token, refreshToken, tokenExpires }`.

| Status | Body |
|---|---|
| 401 | `{ "error": "Missing Authorization header" }` |
| 401 | `{ "error": "Invalid or expired refresh token" }` |
| 401 | `{ "error": "Invalid token type" }` (e.g. an access token sent instead of a refresh token) |
| 500 | `{ "error": "Server configuration error" }`. A server problem, not a reason to sign the user out |

### `POST /api/v1/auth/logout`
`200 { "ok": true }`. Tokens are stateless: the client discards them.

## Resources

### `GET /api/v1/resources/search`
Hybrid full-text + semantic search over active resources.

| Query parameter | Description |
|---|---|
| `q` | **Required.** Plain-text query. Whitespace and line breaks are collapsed into single spaces, and a query over **200 characters** is cut quietly at the last word boundary before the limit (every word of the query has to match, so half a word would empty the results). Missing or blank: `400 { "error": "Missing required query parameter: q" }` |
| `limit` | Page size, default 20, clamped to 1–50 |
| `sort` | `relevance` (default), `rating`, `most_reviewed`, `duration_asc`, `duration_desc`, `newest`. Unknown values are treated as `relevance` |
| `cursor` | `next_cursor` from the previous page. Send it back unchanged, with the same `q`, `sort` and filters. A cursor that is malformed, longer than 1,000 characters, or was made for a different `sort`: `400 { "error": "Invalid cursor" }` |
| `level` | Filter, repeatable (`?level=beginner&level=advanced`): `beginner`, `intermediate`, `advanced`, `all_levels` |
| `resource_type` | Filter, repeatable: `course`, `program`, `degree`, `project`, `certification`, `code_along` |
| `provider`, `language` | Filters, repeatable, any value (e.g. `coursera`, `en`) |
| `is_free`, `has_certificate` | `true` or `false`. Other values are ignored |

**Filter values:** empty values are ignored. Each filter takes at most **20** values of at most **50** characters.
A filter value the API can't use is refused rather than ignored, because ignoring it would return results the client
didn't ask for:

| Status | Body |
|---|---|
| 400 | `{ "error": "Invalid level: \"expert\"", "allowed": [...] }` (same for `resource_type`) |
| 400 | `{ "error": "Too many provider values", "maxValues": 20 }` (for any filter) |
| 400 | `{ "error": "A language value is too long", "maxLength": 50 }` (for any filter) |

`200 { data, next_cursor, vector_search }`:
- `data`: resources with `id, provider, resource_type, provider_type, title, ai_summary, institution, language,
  level, duration_hours, rating, num_ratings, is_free, has_certificate, is_self_paced, skills, career_paths, url`.
- `next_cursor`: string, or `null` on the last page.
- `vector_search`: `true` when semantic similarity was part of the ranking. `false` when the results are ranked by
  keyword relevance only because the semantic part was unavailable (e.g. slow or failing), and always `false` for
  sorts other than `relevance`, which don't use semantic ranking. Which results match is decided by the keywords
  either way: `vector_search` only changes the order within `sort=relevance`.

`429`: search group, see [Rate limits](#rate-limits).

### `GET /api/v1/resources/:id`
One active resource: the search fields plus `external_id, legacy_mongo_id, ai_insights, ai_insights_updated_at,
last_normalized_at`. `404 { "error": "Not found" }` if the id is unknown, malformed or inactive.

## Saved courses

**Access token.** `429`: "everything else" group, see [Rate limits](#rate-limits).

### `GET /api/v1/saved`
`200 { data }`: the user's saved active resources, **newest first**, with the search fields plus `saved_at`.

### `POST /api/v1/saved/:resourceId`
Saves a resource. Idempotent. `200 { "ok": true }`, or `404 { "error": "Resource not found" }`.

### `DELETE /api/v1/saved/:resourceId`
Removes a saved resource. Idempotent, always `200 { "ok": true }`.

## Subjects

All three endpoints are served from a copy of the taxonomy that the API refreshes every 10 minutes, and successful
responses carry `Cache-Control: public, max-age=300` (a browser may reuse them for 5 minutes). After the taxonomy
changes, clients see the change within about 15 minutes.

### `GET /api/v1/subjects`
`200`: flat array of topics `{ id, name, slug, description, meta_description, parent_id, sort_order, course_count }`,
each domain followed by its subtopics.

### `GET /api/v1/subjects/tree`
`200 { domains }`: each domain with a `subtopics` array.

### `GET /api/v1/subjects/:slug`
Domain: `200 { topic, subtopics }`, subtopics ordered by `sort_order` (topics without one last). Subtopic:
`200 { topic, parent }`. `topic` is the full topic record: the list fields plus `cross_provider_insights`,
`insights_updated_at`, `created_at` and `updated_at`. Unknown slug: `404 { "error": "Not found" }`.

## Chat (Cora)

### `POST /api/v1/chat`
Answers a question about courses, grounded in the resources on the user's page and the catalogue.
The answer is streamed as Server-Sent Events.

**Identity** (one is required):

| Header | Who |
|---|---|
| `Authorization: Bearer <token>` | signed-in user (valid access token) |
| `X-Session-ID: <uuid>` | anonymous visitor |

- If both are sent, a valid token wins. If the token is invalid or expired, the session id is used instead.
- `X-Session-ID` must be a UUID (any case, surrounding whitespace ignored), one per browser and reused
  ([requirement 2](#requirements-for-clients)). A new session id doesn't get around the per-network limit below.

**Daily limits.** They reset at midnight UTC. A question counts once it's accepted, and is given back if the answer
fails before any text is streamed.

| Who | Limit | 429 `scope` | 429 `message` |
|---|---|---|---|
| Signed-in user | 10 questions per user | `user` | `You've used all 10 of your daily questions. Your limit resets at midnight UTC.` |
| Signed-in, everyone | a daily total for all signed-in users together (default 1,000) | `signed_in_global` | `Cora has reached today's limit for questions. Please try again after midnight UTC.` |
| Anonymous, per session | 5 questions per `X-Session-ID` | `session` | `You've used all 5 of your daily questions. Sign in to get 10 questions per day.` |
| Anonymous, per network | 20 questions per visitor IP (IPv6: per /64), across all sessions | `ip` | `Too many questions from your network today. Sign in to get 10 questions per day.` |
| Anonymous, everyone | a daily total for all anonymous visitors together (default 1,000) | `global` | `Cora has reached today's limit for guest questions. Sign in to get 10 questions per day.` |

The totals and the per-network limit are deployment settings. `message` is meant to be shown to the user as is.
Anonymous limit messages suggest signing in. Signed-in users are never subject to the anonymous limits.

Separately, every chat request (signed in or not) counts toward the chat [rate limit](#rate-limits) of 10 per minute
per IP. That `429` has `code: "rate_limited"` and isn't a daily limit.

**Body:**

| Field | Type | Required | Limit | Over the limit |
|---|---|---|---|---|
| `message` | string | yes | 4,000 characters, after trimming surrounding whitespace | **`400`** (see below) |
| `history` | `Array<{ role: "user" \| "bot", content: string }>` oldest first | no | most recent **20** turns, each up to **16,000** characters, **32,000** characters in total | Older turns are dropped and long turns are cut. If older turns are dropped, the kept turns start with a `user` turn |
| `pageContextIds` | string[] (resource ids) | no | first **50** distinct, well-formed ids | Extra ids are ignored. Malformed ids and duplicates are ignored and don't count toward the 50 |
| `courseIds` | string[] | no | as `pageContextIds` | **Deprecated** alias, used only when `pageContextIds` is absent |
| `currentPage` | `"SearchResult"` \| `"SavedCourses"` \| `"CourseDetail"` \| `"SubjectPage"` | no | — | Unknown values are treated as `"SearchResult"` (the default) |
| `searchTerm` | string | no | 200 characters | Cut. Whitespace and line breaks are collapsed into single spaces |

Malformed `history` entries and fields of the wrong type are ignored. Content beyond the limits is never used, so
there's no benefit in sending it.

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
| 503 | `{ "error": "Chat is unavailable", "code": "chat_unavailable", "message": "Cora is taking a break. Please try again later." }`: chat is switched off for everyone (an operational switch, for as long as needed). Sent before anything else is checked | no |
| 503 | `{ "error": "Chat is unavailable for guests", "code": "chat_signed_in_only", "message": "Cora is only available to signed-in users right now. Sign in to continue." }`: chat is switched off for anonymous visitors (including requests whose token is invalid) | no |
| 429 | `code: "daily_limit"`, with `scope` and `message` from the table above, `Retry-After` = seconds until midnight UTC ([details](#429-responses)) | no |
| 429 | `code: "rate_limited"`, `Retry-After` = a few seconds ([details](#429-responses)) | no |

**Stream events** (each `data:` line is JSON):

| Event | Meaning |
|---|---|
| `{ "type": "delta", "content": "..." }` | Next piece of the answer (Markdown). Append to the message |
| `{ "type": "done" }` | Answer complete |
| `{ "type": "done", "truncated": true }` | Answer complete but cut short at the length limit. The last `delta` before it is a short note telling the user to ask Cora to continue, so nothing extra needs to be shown. A client may offer a "continue" action |
| `{ "type": "error", "message": "..." }` | Generation failed or took too long (over 2 minutes). `message` is meant for the user. If no `delta` arrived, the question wasn't counted |

**Answer length:** answers are limited to about 4,096 tokens, roughly 12,000–16,000 characters of Markdown. That's enough for a
comparison table of 10 courses with links plus pros and cons for each. Answers longer than that are cut short, as described above.

**Closing the connection** (e.g. aborting the `fetch`) stops the answer on the server. The question still counts,
because the model already started working on it.

## Changelog

### Unreleased

Breaking changes:
- **Calls a server makes for a visitor must carry `X-Relay-Secret` and `X-Visitor-IP`**
  ([details](#calls-from-a-server-on-a-visitors-behalf)). Otherwise they count as the server's own IP and share its limits.
  Every endpoint is now limited per visitor, including resource detail, subjects, token refresh and logout (in the
  "everything else" budget), which previously had no per-minute limit.
- **`X-Session-ID` must be a UUID** (`400` otherwise) and is case-insensitive. Previously any string was accepted.
- **`POST /api/v1/chat`: `message` over 4,000 characters returns `400`** with `maxLength` (previously unlimited).
- **Request body limits:** 512 KB for `POST /api/v1/chat`, 16 KB for every other route. Larger bodies get `413`.
- **Login refuses sign-in methods that aren't accepted** (`403 provider_not_allowed`; the default accepts Google
  only) and unverified email/password accounts (`403 email_not_verified`). Previously every valid Firebase ID token
  was accepted.
- **`GET /api/v1/saved` returns newest first** (previously oldest first).
- **`GET /api/v1/resources/search`:** a malformed cursor, or one made for a different `sort`, returns
  `400 { "error": "Invalid cursor" }` (previously: the first page, or a `500`). Unknown `level` / `resource_type`
  values, more than 20 values for a filter, or a value over 50 characters return `400` (previously: no results, or
  accepted without limit).
- **`GET /api/v1/resources/search`: `vector_search` is `false` for sorts other than `relevance`** (previously `true`
  whenever the embedding service was up, although those sorts never used it).

Other changes:
- **Per-minute rate limits** per visitor: chat 10, search 60, login 20, and 120 shared by every other route
  ([Rate limits](#rate-limits)). Over the limit: `429` with `code: "rate_limited"`.
- **One `429` shape** for every limit ([429 responses](#429-responses)): `error`, `code`, `message`, `retryAfter`,
  `limitReached`, plus `scope` on daily limits. Chat daily-limit `429`s keep `limitReached: true` and `message`.
  Every `429` includes `Retry-After`.
- **`POST /api/v1/chat` daily limits:** besides 5 per session and 10 per signed-in user, new limits across sessions
  (20 anonymous questions per visitor IP per day), and daily totals for all anonymous and all signed-in questions, each
  with its own `scope` and `message`.
- **`POST /api/v1/chat` input limits:** `history`, `pageContextIds`, `courseIds` and `searchTerm` are bounded (extra
  content is dropped quietly, see the table above). Unknown `currentPage` values are treated as `SearchResult`.
- **`POST /api/v1/chat` answers:** limited to about 4,096 tokens of visible text. If an answer hits the limit, a note is streamed
  and `done` carries `truncated: true`. Generation stops after 2 minutes with an `error` event. `history` turns may be up to
  16,000 characters (was 8,000) so long answers are sent back whole. A question counts even if the client disconnects.
- **Login `user.provider`** reports the actual sign-in method (`"google"`, `"email"`, `"github"`, ...). Previously it
  was always `"google"`, which matched the only method in use.
- **CORS:** `Retry-After` is readable by browser code (previously hidden by the browser even though it was sent).
- **`POST /api/v1/chat` can answer `503`** (`chat_unavailable`, `chat_signed_in_only`) when chat is switched off.
- **`GET /api/v1/resources/search`: `q` is cut at 200 characters** (at a word boundary) and its whitespace collapsed
  (previously unlimited). Searches sorted by anything but relevance are faster (no semantic step).
- **Subjects** (`/api/v1/subjects*`): responses carry `Cache-Control: public, max-age=300` (previously `no-store` on
  the list and nothing on the others). The list and tree now refresh every 10 minutes (previously only when the API
  restarted), and `/subjects/:slug` comes from the same copy (previously read live), so a taxonomy change shows up
  within about 15 minutes everywhere.
- **`/health`** answers from a check at most 5 seconds old, and within about 3 seconds when the database hangs.
- **Unexpected `500`s are JSON** (`{ "error": "Internal server error" }`), like every other error. Previously plain text.
