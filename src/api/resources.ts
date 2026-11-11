import { Hono } from 'hono'
import { sql, and, eq, inArray, desc, asc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { learning_resources } from '../db/schema.js'
import { embedQuery } from '../lib/embedding/vertex.js'

export const resourcesRouter = new Hono()

// ─── Cursor helpers ───────────────────────────────────────────────────────────
//
// Each sort mode needs different fields in the cursor to reconstruct the exact
// "after this row" position in the result set. The id is always included as the
// final tiebreaker, guaranteeing uniqueness and stability.
//
// Encoding: JSON → base64url (URL-safe, no padding issues in query strings)

type SortKey = 'relevance' | 'rating' | 'most_reviewed' | 'duration_asc' | 'duration_desc' | 'newest'

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

function decodeCursor(token: string): CursorPayload | null {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString()) as CursorPayload
  } catch {
    return null
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
// Query params:
//   q              required — plain-text search query
//   cursor         opaque pagination token from previous response (omit for first page)
//   limit          default 20, max 50
//   sort           relevance (default) | rating | most_reviewed | duration_asc | duration_desc | newest
//   level          beginner | intermediate | advanced | all_levels  (repeatable)
//   provider       coursera | udemy | edx | pluralsight | datacamp  (repeatable)
//   language       ISO 639-1 code e.g. "en"                         (repeatable)
//   resource_type  course | program | degree | project | certification | code_along (repeatable)
//   is_free        true | false
//   has_certificate true | false

resourcesRouter.get('/search', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) {
    return c.json({ error: 'Missing required query parameter: q' }, 400)
  }

  const limit      = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)))
  const cursorToken = c.req.query('cursor') ?? null
  const sort       = (c.req.query('sort') ?? 'relevance') as SortKey

  const levels         = c.req.queries('level')         ?? []
  const providers      = c.req.queries('provider')      ?? []
  const languages      = c.req.queries('language')      ?? []
  const resource_types = c.req.queries('resource_type') ?? []
  const is_free        = c.req.query('is_free')
  const has_cert       = c.req.query('has_certificate')

  let queryVector: number[] | null = null
  try {
    queryVector = await embedQuery(q)
  } catch {
    // fall through — keyword-only search
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

  if (cursorToken) {
    const cursor = decodeCursor(cursorToken)
    if (cursor) conditions.push(buildCursorCondition(cursor, relevanceScore))
  }

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
// :id accepts either a UUID or a legacy MongoDB ID

resourcesRouter.get('/:id', async (c) => {
  const id = c.req.param('id')

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
    .where(
      // A UUID is 36 chars with dashes; a MongoDB ObjectId is 24 hex chars.
      // Passing a non-UUID string to eq(id, ...) causes Postgres to throw
      // "invalid input syntax for type uuid" before the OR is evaluated.
      // Use a single precise condition based on the ID format to avoid this.
      /^[0-9a-f]{24}$/i.test(id)
        ? eq(learning_resources.legacy_mongo_id, id)
        : eq(learning_resources.id, id),
    )
    .limit(1)

  if (row.length === 0 || !row[0].is_active) {
    return c.json({ error: 'Not found' }, 404)
  }

  const { source_url, affiliate_url, is_active, ...rest } = row[0]

  return c.json({ ...rest, url: affiliate_url ?? source_url })
})
