import { Hono } from 'hono'
import { sql, and, eq, inArray, desc, asc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { learning_resources } from '../db/schema.js'
import { embedQuery } from '../lib/embedding/vertex.js'
import { QueryEmbeddingCache } from '../lib/embedding/query-cache.js'
import { registerInstanceState } from '../lib/instance-state.js'
import { isUuid } from '../lib/ids.js'
import { logError } from '../lib/logger.js'
import { collapseWhitespace, truncateAtWord } from '../lib/text.js'
import { matchResourceId } from './resource-ids.js'

export const resourcesRouter = new Hono()

// ─── Search input limits (docs/api.md) ────────────────────────────────────────
//
// Every search can call the paid embedding API and runs a ranking query, so
// all input is bounded and checked before either happens.

export const SEARCH_LIMITS = {
  /** `q` is cut to this length (after collapsing whitespace, at a word boundary), quietly: D12. */
  queryMaxChars: 200,
  /** Values per filter parameter (e.g. ?provider=a&provider=b). More gets 400. */
  filterMaxValues: 20,
  /** Length of one filter value. Longer gets 400. */
  filterValueMaxChars: 50,
  /** Length of `cursor`. Real cursors are far shorter. Longer gets 400. */
  cursorMaxChars: 1_000,
} as const

export const LEVELS = ['beginner', 'intermediate', 'advanced', 'all_levels'] as const
export const RESOURCE_TYPES = ['course', 'program', 'degree', 'project', 'certification', 'code_along'] as const
const SORT_KEYS = ['relevance', 'rating', 'most_reviewed', 'duration_asc', 'duration_desc', 'newest'] as const

// Per-instance cache of query embeddings (see query-cache.ts): page 2, 3, ...
// of a search reuse page 1's embedding instead of calling the API again.
const queryEmbeddings = new QueryEmbeddingCache(embedQuery)
registerInstanceState(() => queryEmbeddings.clear())

// ─── Cursor helpers ───────────────────────────────────────────────────────────
//
// Each sort mode needs different fields in the cursor to reconstruct the exact
// "after this row" position in the result set. The id is always included as the
// final tiebreaker, guaranteeing uniqueness and stability.
//
// Encoding: JSON → base64url (URL-safe, no padding issues in query strings)

type SortKey = typeof SORT_KEYS[number]

interface CursorPayload {
  sort: SortKey
  id: string
  score?: number           // relevance sort
  rating?: number | null   // rating sort
  num_ratings?: number | null  // most_reviewed sort
  duration_hours?: number | null // duration sorts
  created_at?: string      // newest sort (ISO 8601)
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Decodes and fully validates a cursor for the given sort, or returns null.
 * Everything in it ends up in SQL, so a made-up cursor must be refused here
 * (400) rather than fail in Postgres (500) or page through the wrong order.
 */
function parseCursor(token: string, sort: SortKey): CursorPayload | null {
  if (token.length > SEARCH_LIMITS.cursorMaxChars) return null
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(token, 'base64url').toString())
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const c = raw as Record<string, unknown>
  // A cursor only continues the sort it was made for.
  if (c['sort'] !== sort || typeof c['id'] !== 'string' || !isUuid(c['id'])) return null

  const nullOr = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v)
  switch (sort) {
    case 'relevance':
      return isFiniteNumber(c['score']) ? { sort, id: c['id'], score: c['score'] } : null
    case 'rating':
      return nullOr(isFiniteNumber)(c['rating'])
        ? { sort, id: c['id'], rating: c['rating'] as number | null } : null
    case 'most_reviewed':
      return nullOr(Number.isSafeInteger)(c['num_ratings'])
        ? { sort, id: c['id'], num_ratings: c['num_ratings'] as number | null } : null
    case 'duration_asc':
    case 'duration_desc':
      return nullOr(isFiniteNumber)(c['duration_hours'])
        ? { sort, id: c['id'], duration_hours: c['duration_hours'] as number | null } : null
    case 'newest': {
      const at = c['created_at']
      return typeof at === 'string' && ISO_TIMESTAMP.test(at) && !Number.isNaN(Date.parse(at))
        ? { sort, id: c['id'], created_at: at } : null
    }
  }
}

// Builds the WHERE condition that finds rows strictly after the cursor position.
// Each sort has a different keyset condition. NULLS LAST sorts need explicit
// NULL handling since NULL comparisons don't behave intuitively in SQL.
function buildCursorCondition(cursor: CursorPayload, relevanceExpr: ReturnType<typeof sql<number>>) {
  const id = cursor.id
  const lr = learning_resources

  switch (cursor.sort) {
    case 'relevance': {
      const s = cursor.score!
      // score DESC, id ASC
      return sql`(${relevanceExpr} < ${s} OR (${relevanceExpr} = ${s} AND ${lr.id} > ${id}))`
    }

    case 'rating': {
      // rating DESC NULLS LAST, id ASC
      if (cursor.rating === null) {
        return sql`(${lr.rating} IS NULL AND ${lr.id} > ${id})`
      }
      const r = cursor.rating
      return sql`(${lr.rating} < ${r} OR ${lr.rating} IS NULL OR (${lr.rating} = ${r} AND ${lr.id} > ${id}))`
    }

    case 'most_reviewed': {
      // num_ratings DESC NULLS LAST, id ASC
      if (cursor.num_ratings === null) {
        return sql`(${lr.num_ratings} IS NULL AND ${lr.id} > ${id})`
      }
      const n = cursor.num_ratings
      return sql`(${lr.num_ratings} < ${n} OR ${lr.num_ratings} IS NULL OR (${lr.num_ratings} = ${n} AND ${lr.id} > ${id}))`
    }

    case 'duration_asc': {
      // duration_hours ASC NULLS LAST, id ASC
      if (cursor.duration_hours === null) {
        return sql`(${lr.duration_hours} IS NULL AND ${lr.id} > ${id})`
      }
      const d = cursor.duration_hours
      return sql`(${lr.duration_hours} > ${d} OR ${lr.duration_hours} IS NULL OR (${lr.duration_hours} = ${d} AND ${lr.id} > ${id}))`
    }

    case 'duration_desc': {
      // duration_hours DESC NULLS LAST, id ASC
      if (cursor.duration_hours === null) {
        return sql`(${lr.duration_hours} IS NULL AND ${lr.id} > ${id})`
      }
      const d = cursor.duration_hours
      return sql`(${lr.duration_hours} < ${d} OR ${lr.duration_hours} IS NULL OR (${lr.duration_hours} = ${d} AND ${lr.id} > ${id}))`
    }

    case 'newest': {
      // created_at DESC, id ASC  (created_at is NOT NULL)
      const ca = cursor.created_at!
      return sql`(${lr.created_at} < ${ca}::timestamptz OR (${lr.created_at} = ${ca}::timestamptz AND ${lr.id} > ${id}))`
    }
  }
}

function buildOrderBy(sort: SortKey, relevanceExpr: ReturnType<typeof sql<number>>) {
  const idAsc = asc(learning_resources.id)
  switch (sort) {
    case 'rating':        return [sql`${learning_resources.rating} DESC NULLS LAST`,        idAsc]
    case 'most_reviewed': return [sql`${learning_resources.num_ratings} DESC NULLS LAST`,   idAsc]
    case 'duration_asc':  return [sql`${learning_resources.duration_hours} ASC NULLS LAST`, idAsc]
    case 'duration_desc': return [sql`${learning_resources.duration_hours} DESC NULLS LAST`, idAsc]
    case 'newest':        return [desc(learning_resources.created_at),                       idAsc]
    default:              return [desc(relevanceExpr),                                       idAsc]
  }
}

function buildNextCursor(sort: SortKey, row: {
  id: string
  _score: number
  rating: number | null
  num_ratings: number | null
  duration_hours: number | null
  _created_at: Date
}): string {
  switch (sort) {
    case 'rating':        return encodeCursor({ sort, id: row.id, rating: row.rating })
    case 'most_reviewed': return encodeCursor({ sort, id: row.id, num_ratings: row.num_ratings })
    case 'duration_asc':
    case 'duration_desc': return encodeCursor({ sort, id: row.id, duration_hours: row.duration_hours })
    case 'newest':        return encodeCursor({ sort, id: row.id, created_at: row._created_at.toISOString() })
    default:              return encodeCursor({ sort: 'relevance', id: row.id, score: row._score })
  }
}

// ─── Search endpoint ──────────────────────────────────────────────────────────
//
// Query params (limits and errors: SEARCH_LIMITS above, docs/api.md):
//   q              required — plain-text search query, cut to 200 characters
//   cursor         opaque pagination token from previous response (omit for first page)
//   limit          default 20, max 50
//   sort           relevance (default) | rating | most_reviewed | duration_asc | duration_desc | newest
//   level          beginner | intermediate | advanced | all_levels  (repeatable)
//   provider       coursera | udemy | edx | pluralsight | datacamp  (repeatable)
//   language       ISO 639-1 code e.g. "en"                         (repeatable)
//   resource_type  course | program | degree | project | certification | code_along (repeatable)
//   is_free        true | false
//   has_certificate true | false

/**
 * Reads one repeatable filter parameter: empty values are dropped; too many
 * values, values that are too long or (with `allowed`) unknown values give a
 * 400 body. A filter decides which results come back, so a value the API
 * can't use is refused rather than ignored (ignoring it would return results
 * the client didn't ask for).
 */
function readFilter(
  values: string[] | undefined,
  name: string,
  allowed?: readonly string[],
): { ok: true; values: string[] } | { ok: false; error: Record<string, unknown> } {
  const list = (values ?? []).map(v => v.trim()).filter(Boolean)
  if (list.length > SEARCH_LIMITS.filterMaxValues) {
    return { ok: false, error: { error: `Too many ${name} values`, maxValues: SEARCH_LIMITS.filterMaxValues } }
  }
  if (list.some(v => v.length > SEARCH_LIMITS.filterValueMaxChars)) {
    return { ok: false, error: { error: `A ${name} value is too long`, maxLength: SEARCH_LIMITS.filterValueMaxChars } }
  }
  const unknown = allowed ? list.find(v => !allowed.includes(v)) : undefined
  if (unknown !== undefined) {
    return { ok: false, error: { error: `Invalid ${name}: "${unknown}"`, allowed } }
  }
  return { ok: true, values: list }
}

resourcesRouter.get('/search', async (c) => {
  // ── Input: everything is checked before any paid or heavy work ──────────
  // D12: an over-long query is cut quietly, not refused: a pasted paragraph
  // or an old shared link still searches, and the same long query always
  // becomes the same text, so its cursors keep working.
  const q = truncateAtWord(collapseWhitespace(c.req.query('q') ?? ''), SEARCH_LIMITS.queryMaxChars)
  if (!q) {
    return c.json({ error: 'Missing required query parameter: q' }, 400)
  }

  const parsedLimit = parseInt(c.req.query('limit') ?? '', 10)
  const limit      = Number.isNaN(parsedLimit) ? 20 : Math.min(50, Math.max(1, parsedLimit))
  const requestedSort = c.req.query('sort')
  const sort: SortKey = SORT_KEYS.find(k => k === requestedSort) ?? 'relevance'

  const level = readFilter(c.req.queries('level'), 'level', LEVELS)
  if (!level.ok) return c.json(level.error, 400)
  const provider = readFilter(c.req.queries('provider'), 'provider')
  if (!provider.ok) return c.json(provider.error, 400)
  const language = readFilter(c.req.queries('language'), 'language')
  if (!language.ok) return c.json(language.error, 400)
  const resourceType = readFilter(c.req.queries('resource_type'), 'resource_type', RESOURCE_TYPES)
  if (!resourceType.ok) return c.json(resourceType.error, 400)
  const [levels, providers, languages, resource_types] =
    [level.values, provider.values, language.values, resourceType.values]
  const is_free        = c.req.query('is_free')
  const has_cert       = c.req.query('has_certificate')

  const cursorToken = c.req.query('cursor')
  let cursor: CursorPayload | null = null
  if (cursorToken) {
    cursor = parseCursor(cursorToken, sort)
    if (!cursor) return c.json({ error: 'Invalid cursor' }, 400)
  }

  // ── Embedding: only relevance ranking uses it ────────────────────────────
  let queryVector: Float32Array | null = null
  if (sort === 'relevance') {
    try {
      queryVector = await queryEmbeddings.get(q)
    } catch (err) {
      // Keyword-only search instead (vector_search: false). Logged so an
      // embedding outage or timeouts show up in Error Reporting.
      logError('search_embedding_failed', err)
    }
  }

  const tsQuery = sql`plainto_tsquery('english', ${q})`
  const relevanceScore = queryVector
    ? sql<number>`(
        0.6 * ts_rank(${learning_resources.search_document}, ${tsQuery}) +
        0.4 * CASE
          WHEN ${learning_resources.embedding} IS NOT NULL
          THEN 1 - (${learning_resources.embedding} <=> ${`[${queryVector.join(',')}]`}::vector)
          ELSE 0
        END
      )`
    : sql<number>`ts_rank(${learning_resources.search_document}, ${tsQuery})`

  const conditions = [
    eq(learning_resources.is_active, true),
    sql`${learning_resources.search_document} @@ ${tsQuery}`,
    ...(levels.length         ? [inArray(learning_resources.level,         levels as never[])]         : []),
    ...(providers.length      ? [inArray(learning_resources.provider,      providers)]                 : []),
    ...(languages.length      ? [inArray(learning_resources.language,      languages)]                 : []),
    ...(resource_types.length ? [inArray(learning_resources.resource_type, resource_types as never[])] : []),
    ...(is_free  === 'true' || is_free  === 'false' ? [eq(learning_resources.is_free,        is_free  === 'true')] : []),
    ...(has_cert === 'true' || has_cert === 'false' ? [eq(learning_resources.has_certificate, has_cert === 'true')] : []),
  ]

  if (cursor) conditions.push(buildCursorCondition(cursor, relevanceScore))

  const rows = await db
    .select({
      id:              learning_resources.id,
      provider:        learning_resources.provider,
      resource_type:   learning_resources.resource_type,
      provider_type:   learning_resources.provider_type,
      title:           learning_resources.title,
      ai_summary:      learning_resources.ai_summary,
      institution:     learning_resources.institution,
      language:        learning_resources.language,
      level:           learning_resources.level,
      duration_hours:  learning_resources.duration_hours,
      rating:          learning_resources.rating,
      num_ratings:     learning_resources.num_ratings,
      is_free:         learning_resources.is_free,
      has_certificate: learning_resources.has_certificate,
      is_self_paced:   learning_resources.is_self_paced,
      skills:          learning_resources.skills,
      career_paths:    learning_resources.career_paths,
      source_url:      learning_resources.source_url,
      affiliate_url:   learning_resources.affiliate_url,
      // cursor-building fields (stripped from response)
      _score:          relevanceScore,
      _created_at:     learning_resources.created_at,
    })
    .from(learning_resources)
    .where(and(...conditions))
    .orderBy(...buildOrderBy(sort, relevanceScore))
    .limit(limit + 1) // fetch one extra to know if there are more results

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const lastRow = page[page.length - 1]
  const nextCursor = hasMore && lastRow ? buildNextCursor(sort, lastRow) : null

  const results = page.map(({ source_url, affiliate_url, _score, _created_at, ...rest }) => ({
    ...rest,
    url: affiliate_url ?? source_url,
  }))

  return c.json({ data: results, next_cursor: nextCursor, vector_search: queryVector !== null })
})

// ─── Resource detail ──────────────────────────────────────────────────────────
//
// :id accepts either a UUID or a legacy MongoDB ID (TODO(legacy-mongo-ids))

resourcesRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const match = matchResourceId(id)

  if (!match) {
    return c.json({ error: 'Not found' }, 404)
  }

  const row = await db
    .select({
      id:              learning_resources.id,
      provider:        learning_resources.provider,
      external_id:     learning_resources.external_id,
      provider_type:   learning_resources.provider_type,
      resource_type:   learning_resources.resource_type,
      legacy_mongo_id: learning_resources.legacy_mongo_id,
      title:           learning_resources.title,
      ai_summary:      learning_resources.ai_summary,
      institution:     learning_resources.institution,
      language:        learning_resources.language,
      level:           learning_resources.level,
      duration_hours:  learning_resources.duration_hours,
      rating:          learning_resources.rating,
      num_ratings:     learning_resources.num_ratings,
      is_free:         learning_resources.is_free,
      has_certificate: learning_resources.has_certificate,
      is_self_paced:   learning_resources.is_self_paced,
      skills:          learning_resources.skills,
      career_paths:    learning_resources.career_paths,
      source_url:      learning_resources.source_url,
      affiliate_url:   learning_resources.affiliate_url,
      ai_insights:     learning_resources.ai_insights,
      ai_insights_updated_at: learning_resources.ai_insights_updated_at,
      last_normalized_at: learning_resources.last_normalized_at,
      is_active:       learning_resources.is_active,
    })
    .from(learning_resources)
    .where(match)
    .limit(1)

  if (row.length === 0 || !row[0].is_active) {
    return c.json({ error: 'Not found' }, 404)
  }

  const { source_url, affiliate_url, is_active, ...rest } = row[0]

  return c.json({ ...rest, url: affiliate_url ?? source_url })
})
