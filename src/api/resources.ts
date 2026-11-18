import { Hono } from 'hono'
import { db } from '../db/client.js'
import { learning_resources } from '../db/schema.js'
import { log } from '../lib/logger.js'
import { collapseWhitespace, truncateAtWord } from '../lib/text.js'
import { parseCursor, type Cursor, type RankingMode } from '../search/cursor.js'
import { filterNames, LEVELS, RESOURCE_TYPES, type SearchFilters } from '../search/filters.js'
import { SORT_KEYS, type SortKey } from '../search/ordering.js'
import { search, SearchUnavailableError, type EmbeddingUse, type SearchOutcome } from '../search/search.js'
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

// ─── Search endpoint ──────────────────────────────────────────────────────────
//
// HTTP only: reading and checking the input, the response and the log line.
// The search itself is src/search/ (how it works: docs/search.md).
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
 * One line per answered search (docs/operations.md, "Search logs"): what kind
 * of search it was and how it went, for the zero-result rate, filter and sort
 * usage, paging depth, embedding cost and tuning. Never the query text (people
 * type personal data into search boxes), and no identity.
 */
interface SearchLogEvent {
  event: 'search'
  sort: SortKey
  /** How the results were ranked: with the query embedding, or keywords only. */
  mode: RankingMode
  /** The query embedding: from the per-instance cache, from the API, failed, or not used (keyword cursor). */
  embedding: EmbeddingUse
  /** 'first' without a cursor; the zero-result rate counts first pages only. */
  page: 'first' | 'next'
  results: number
  has_more: boolean
  /** Words in the (normalized, capped) query: tells keyword searches from questions, without the text. */
  query_words: number
  /** Whether a typo correction was applied (the query was searched as corrected_query). */
  corrected: boolean
  /** Names of the filters used, never their values. */
  filters: string[]
  /** Which keyword tier ran last: all words, any word, or none (no keyword terms). */
  keyword_tier: SearchOutcome['diagnostics']['keywordTier']
  keyword_candidates: number
  semantic_candidates: number
  /** A keyword tier read its maximum number of matches (config.ts, scanCap): more matched than were ranked. */
  scan_cap_hit: boolean
  duration_ms: number
}

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

/** `true` / `false`; anything else doesn't filter (documented: other values are ignored). */
function readBoolean(value: string | undefined): boolean | undefined {
  return value === 'true' ? true : value === 'false' ? false : undefined
}

resourcesRouter.get('/search', async (c) => {
  const startedAt = Date.now()
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
  const filters: SearchFilters = {
    level: level.values,
    provider: provider.values,
    language: language.values,
    resource_type: resourceType.values,
    is_free: readBoolean(c.req.query('is_free')),
    has_certificate: readBoolean(c.req.query('has_certificate')),
  }

  const cursorToken = c.req.query('cursor')
  let cursor: Cursor | null = null
  if (cursorToken) {
    // The frontend matches this exact message (it offers to reload the results).
    cursor = parseCursor(cursorToken, sort, SEARCH_LIMITS.cursorMaxChars)
    if (!cursor) return c.json({ error: 'Invalid cursor' }, 400)
  }

  // ── Search ───────────────────────────────────────────────────────────────
  let outcome: SearchOutcome
  try {
    outcome = await search({ query: q, sort, limit, filters, cursor })
  } catch (err) {
    if (err instanceof SearchUnavailableError) {
      // Page 1 was ranked with the query embedding, which is unavailable right
      // now. Retrying the same cursor works once it's back (docs/api.md).
      return c.json({ error: 'Search is temporarily unavailable', code: 'search_unavailable' }, 503)
    }
    throw err
  }

  const results = outcome.results.map(({ source_url, affiliate_url, ...rest }) => ({
    ...rest,
    url: affiliate_url ?? source_url,
  }))

  const { diagnostics } = outcome
  log({
    event: 'search',
    sort,
    mode: outcome.mode,
    embedding: diagnostics.embedding,
    page: cursor ? 'next' : 'first',
    results: results.length,
    has_more: outcome.nextCursor !== null,
    query_words: q.split(' ').length,
    corrected: outcome.correctedQuery !== null,
    filters: filterNames(filters),
    keyword_tier: diagnostics.keywordTier,
    keyword_candidates: diagnostics.keywordCandidates,
    semantic_candidates: diagnostics.semanticCandidates,
    scan_cap_hit: diagnostics.scanCapHit,
    duration_ms: Date.now() - startedAt,
  } satisfies SearchLogEvent)

  return c.json({
    data: results,
    next_cursor: outcome.nextCursor,
    vector_search: outcome.mode === 'hybrid',
    corrected_query: outcome.correctedQuery,
  })
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
