/**
 * Where result lists come from:
 *
 * - apiRetriever: the search API under test, over HTTP, exactly as a client
 *   calls it (query-embedding cache included).
 * - keywordAnyRetriever, semanticRetriever: simple reference rankers that
 *   query the database directly. They're not candidates for production (no
 *   caps, no tuning). They widen the judged pool, so the evaluation isn't
 *   limited to what today's search happens to show: a new ranker that finds
 *   good resources the old one missed gets credit for them.
 *
 * All return ids; details come from loadResources() so every source is stored
 * the same way.
 */
import { and, inArray, sql } from 'drizzle-orm'
import { learning_resources } from '../../src/db/schema.js'
import type { Db } from '../../src/search/db.js'
import { filterConditions } from '../../src/search/filters.js'
import type { QueryRow } from './queries.js'
import { parseFilters } from './queries.js'
import type { JudgeResource } from './judge.js'
import type { StoredResult } from './store.js'

export type { Db }

export interface RetrievedList {
  status: number
  ids: string[]
  vector_search: boolean | null
  /** The API's corrected_query (typo correction), if any. */
  corrected_query?: string | null
  /** Semantic reference ranker: cosine distance of each id (same order). */
  distances?: number[]
}

export interface Retriever {
  /** Stored in the run file. */
  source: string
  /** Whether timing it and repeating it means anything (the API: yes; reference rankers: no). */
  measured: boolean
  retrieve(row: QueryRow, topK: number): Promise<RetrievedList>
}

/** Sends a GET for `pathAndQuery` (e.g. "/api/v1/resources/search?q=...") to the API. */
export type FetchPath = (pathAndQuery: string) => Promise<Response>

export function apiRetriever(fetchPath: FetchPath, description: string): Retriever {
  return {
    source: `api ${description}`,
    measured: true,
    async retrieve(row, topK) {
      const params = new URLSearchParams({ q: row.query, limit: String(topK) })
      const path = `/api/v1/resources/search?${params}${row.filters ? `&${row.filters}` : ''}`
      for (let attempt = 0; ; attempt++) {
        const res = await fetchPath(path)
        if (res.status === 429 && attempt < 3) {
          // Rate limited: set RATE_LIMIT_SEARCH_PER_MIN=0 on the API under test to avoid waiting.
          const seconds = Number(res.headers.get('retry-after')) || 5
          await new Promise(r => setTimeout(r, seconds * 1000))
          continue
        }
        if (res.status !== 200) return { status: res.status, ids: [], vector_search: null }
        const body = await res.json() as { data: Array<{ id: string }>; vector_search: boolean; corrected_query?: string | null }
        return {
          status: 200, ids: body.data.map(r => r.id), vector_search: body.vector_search,
          corrected_query: body.corrected_query ?? null,
        }
      }
    },
  }
}

/**
 * Any query word matches, ranked by ts_rank_cd: what "match any word" gives
 * without coverage ranking or stop words. Reads every match, so broad
 * queries are slow on a big catalogue (fine for an offline tool).
 */
export function keywordAnyRetriever(db: Db): Retriever {
  return {
    source: 'seed: keyword, any word, ts_rank_cd',
    measured: false,
    async retrieve(row, topK) {
      // The query's lexemes, OR'ed. Each is quoted for tsquery input ('' escapes a quote, \\ a backslash).
      const anyWord = sql`(array_to_string(array(
          SELECT '''' || replace(replace(lexeme, '\\', '\\\\'), '''', '''''') || ''''
          FROM unnest(tsvector_to_array(to_tsvector('english', ${row.query}))) AS lexeme
        ), ' | '))::tsquery`
      const rows = await db
        .select({ id: learning_resources.id })
        .from(learning_resources)
        .where(and(...filterConditions(parseFilters(row.filters)), sql`${learning_resources.search_document} @@ ${anyWord}`))
        .orderBy(sql`ts_rank_cd(${learning_resources.search_document}, ${anyWord}) DESC`, learning_resources.id)
        .limit(topK)
      return { status: 200, ids: rows.map(r => r.id), vector_search: false }
    },
  }
}

/**
 * Nearest neighbours of the query embedding (HNSW), filters applied during
 * the scan (iterative scan), no similarity floor.
 */
export function semanticRetriever(db: Db, embed: (text: string) => Promise<ArrayLike<number>>): Retriever {
  return {
    source: 'seed: semantic, HNSW nearest neighbours',
    measured: false,
    async retrieve(row, topK) {
      const vector = `[${Array.from(await embed(row.query)).join(',')}]`
      // Uncast: the parameter takes the column's type (vector or halfvec), so the index is used either way.
      const distance = sql`${learning_resources.embedding} <=> ${vector}`
      const ids = await db.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${Math.max(40, topK)}`))
        await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
        const nearest = await tx
          .select({ id: learning_resources.id, distance: sql<number>`${distance}`.as('distance') })
          .from(learning_resources)
          .where(and(...filterConditions(parseFilters(row.filters)), sql`${learning_resources.embedding} IS NOT NULL`))
          .orderBy(distance)
          .limit(topK)
        // relaxed_order can return neighbours slightly out of order: re-sort by distance.
        return nearest.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
      })
      return { status: 200, ids: ids.map(r => r.id), vector_search: true, distances: ids.map(r => Number(r.distance)) }
    },
  }
}

export type ResourceDetails = StoredResult & JudgeResource

/** Everything the evaluation stores or judges about some resources, by id (unknown ids are left out). */
export async function loadResources(db: Db, ids: readonly string[]): Promise<Map<string, ResourceDetails>> {
  if (ids.length === 0) return new Map()
  const lr = learning_resources
  const rows = await db
    .select({
      id: lr.id, provider: lr.provider, external_id: lr.external_id, title: lr.title, level: lr.level,
      language: lr.language, resource_type: lr.resource_type, is_free: lr.is_free, has_certificate: lr.has_certificate,
      provider_type: lr.provider_type, institution: lr.institution, duration_hours: lr.duration_hours,
      skills: lr.skills, ai_summary: lr.ai_summary,
    })
    .from(lr)
    .where(inArray(lr.id, [...new Set(ids)]))
  return new Map(rows.map(({ external_id, ...r }) => [r.id, { ...r, key: `${r.provider}:${external_id}` }]))
}

export function toStoredResult(r: ResourceDetails): StoredResult {
  const { id, key, title, provider, level, language, resource_type, is_free, has_certificate } = r
  return { id, key, title, provider, level, language, resource_type, is_free, has_certificate }
}
