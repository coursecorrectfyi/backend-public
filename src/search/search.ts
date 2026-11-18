/**
 * Search: keyword and semantic candidates, fused, ordered, paged.
 *
 *   query ─► typo correction (vocabulary.ts)
 *         ─► keyword terms (query.ts) ─► keyword candidates (keyword.ts) ─┐
 *         ─► query embedding (cached) ─► semantic candidates (semantic.ts) ┴► fusion (fusion.ts)
 *         ─► order by the requested sort (ordering.ts) ─► the page after the cursor (cursor.ts)
 *
 * Every sort orders the same candidates, so a search shows the same results
 * whatever the sort, and the work per request is bounded by the candidate
 * counts in config.ts, not by how many resources match.
 *
 * Ranking mode: 'hybrid' when the query embedding is available, 'keyword'
 * when it isn't (embedding API failing or slow). The cursor records the mode
 * of page 1, and later pages use the same one. A keyword cursor doesn't call
 * the embedding API. A hybrid cursor without an embedding fails with
 * SearchUnavailableError (503) rather than continuing in another order,
 * which would skip or repeat results.
 *
 * How it works and how to tune it: docs/search.md.
 */
import { inArray } from 'drizzle-orm'
import { db as appDb } from '../db/client.js'
import { learning_resources as lr } from '../db/schema.js'
import { embedQuery } from '../lib/embedding/vertex.js'
import { QueryEmbeddingCache } from '../lib/embedding/query-cache.js'
import { registerInstanceState } from '../lib/instance-state.js'
import { logError } from '../lib/logger.js'
import { SEARCH_CONFIG, type SearchConfig } from './config.js'
import { encodeCursor, type Cursor, type RankingMode } from './cursor.js'
import type { Db } from './db.js'
import type { SearchFilters } from './filters.js'
import { fuse } from './fusion.js'
import { keywordCandidates, type KeywordCandidates } from './keyword.js'
import { comparePositions, orderCandidates, type SortKey } from './ordering.js'
import { keywordTerms } from './query.js'
import { semanticCandidates } from './semantic.js'
import { correctTypos } from './vocabulary.js'

// Per-instance cache of query embeddings (query-cache.ts): page 2, 3, … and the
// other sorts of a search reuse page 1's embedding instead of calling the API again.
const queryEmbeddings = new QueryEmbeddingCache(embedQuery)
registerInstanceState(() => queryEmbeddings.clear())

/** What a search result shows (the API adds `url` and drops the two URL columns). */
export const RESULT_COLUMNS = {
  id: lr.id,
  provider: lr.provider,
  resource_type: lr.resource_type,
  provider_type: lr.provider_type,
  title: lr.title,
  ai_summary: lr.ai_summary,
  institution: lr.institution,
  language: lr.language,
  level: lr.level,
  duration_hours: lr.duration_hours,
  rating: lr.rating,
  num_ratings: lr.num_ratings,
  is_free: lr.is_free,
  has_certificate: lr.has_certificate,
  is_self_paced: lr.is_self_paced,
  skills: lr.skills,
  career_paths: lr.career_paths,
  source_url: lr.source_url,
  affiliate_url: lr.affiliate_url,
}

export interface SearchRequest {
  /** Normalized and length-capped by the API. */
  query: string
  sort: SortKey
  limit: number
  filters: SearchFilters
  /** Validated for `sort` (parseCursor), or null for page 1. */
  cursor: Cursor | null
}

/** How the query embedding was obtained (for the search log). */
export type EmbeddingUse = 'cached' | 'computed' | 'failed' | 'not_needed'

/** The display fields of the given resources (any order). */
function loadResults(db: Db, ids: string[]) {
  return db.select(RESULT_COLUMNS).from(lr).where(inArray(lr.id, ids))
}

export type SearchResult = Awaited<ReturnType<typeof loadResults>>[number]

export interface SearchOutcome {
  /** The page, in order. */
  results: SearchResult[]
  nextCursor: string | null
  mode: RankingMode
  /** The query with unknown words replaced by their closest catalogue word, when any were. */
  correctedQuery: string | null
  /** For the search log. */
  diagnostics: {
    embedding: EmbeddingUse
    keywordTier: KeywordCandidates['tier']
    keywordCandidates: number
    semanticCandidates: number
    scanCapHit: boolean
  }
}

/** A page ranked with embeddings can't be continued: the query embedding is unavailable. */
export class SearchUnavailableError extends Error {
  constructor() {
    super('Query embedding unavailable: a hybrid-ranked search cannot be continued')
    this.name = 'SearchUnavailableError'
  }
}

export async function search(
  request: SearchRequest,
  options: { db?: Db; config?: SearchConfig } = {},
): Promise<SearchOutcome> {
  const db = options.db ?? appDb
  const config = options.config ?? SEARCH_CONFIG
  const { sort, limit, filters, cursor } = request

  const correctedQuery = await correctTypos(db, request.query, config)
  const text = correctedQuery ?? request.query

  // ── Ranking mode ──────────────────────────────────────────────────────────
  let mode: RankingMode = 'keyword'
  let queryVector: Float32Array | null = null
  let embedding: EmbeddingUse = 'not_needed'
  if (cursor?.mode !== 'keyword') {
    embedding = queryEmbeddings.has(text) ? 'cached' : 'computed'
    try {
      queryVector = await queryEmbeddings.get(text)
      mode = 'hybrid'
    } catch (err) {
      // Logged so an embedding outage or timeouts show up in Error Reporting.
      logError('search_embedding_failed', err)
      embedding = 'failed'
      if (cursor) throw new SearchUnavailableError() // page 1 was hybrid: don't switch order mid-way
    }
  }

  // ── Candidates, fused and ordered ────────────────────────────────────────
  const terms = await keywordTerms(db, text, config)
  const { keyword, semantic } = await db.transaction(async tx => ({
    keyword: await keywordCandidates(tx, terms, filters, config),
    semantic: queryVector ? await semanticCandidates(tx, queryVector, filters, config) : null,
  }), { accessMode: 'read only' })
  const ordered = orderCandidates(sort, fuse(keyword.candidates, semantic, config.fusion.rrfK), config)

  // ── The page after the cursor ────────────────────────────────────────────
  const start = cursor ? ordered.findIndex(o => comparePositions(sort, o.position, cursor) > 0) : 0
  const remaining = start === -1 ? [] : ordered.slice(start)
  const page = remaining.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = remaining.length > limit && last
    ? encodeCursor({ v: 2, sort, mode, ...last.position })
    : null

  const rows = page.length === 0 ? [] : await loadResults(db, page.map(p => p.candidate.id))
  const byId = new Map(rows.map(r => [r.id, r]))

  return {
    results: page.flatMap(p => byId.get(p.candidate.id) ?? []),
    nextCursor,
    mode,
    correctedQuery,
    diagnostics: {
      embedding,
      keywordTier: keyword.tier,
      keywordCandidates: keyword.candidates.length,
      semanticCandidates: semantic?.length ?? 0,
      scanCapHit: keyword.scanCapHit,
    },
  }
}
