/**
 * Semantic candidates: the nearest neighbours of the query embedding, through
 * the HNSW index (lr_embedding_hnsw_idx). Must run inside a transaction:
 *
 * - hnsw.ef_search is raised to at least `candidates`. pgvector's default (40)
 *   silently caps an index scan at 40 rows.
 * - hnsw.iterative_scan = relaxed_order: when the filters remove most
 *   neighbours (a rare provider or level), the scan keeps going instead of
 *   returning almost nothing, up to hnsw.max_scan_tuples (config). Results
 *   can come back slightly out of order, so they're re-sorted by distance here.
 * - The distance floor (config) drops weak neighbours. Without it, nonsense
 *   would still get `candidates` results.
 *
 * The query vector is passed uncast, so it takes the column's type (halfvec)
 * and the index applies.
 */
import { and, isNotNull, sql } from 'drizzle-orm'
import { learning_resources as lr } from '../db/schema.js'
import { candidateColumns } from './candidate-columns.js'
import type { SearchConfig } from './config.js'
import type { Db } from './db.js'
import { filterConditions, type SearchFilters } from './filters.js'
import { weightedRating, type Candidate } from './ordering.js'

/** pgvector's default hnsw.ef_search. */
const DEFAULT_EF_SEARCH = 40

export async function semanticCandidates(
  tx: Db,
  queryVector: ArrayLike<number>,
  filters: SearchFilters,
  config: SearchConfig,
): Promise<Candidate[]> {
  const { candidates: wanted, maxDistance, maxDistanceFromBest, maxScanTuples } = config.semantic
  // SET doesn't take parameters; these are numbers from config.ts, made integers here.
  const efSearch = Math.max(DEFAULT_EF_SEARCH, Math.trunc(wanted))
  await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${efSearch}`))
  await tx.execute(sql.raw(`SET LOCAL hnsw.max_scan_tuples = ${Math.trunc(maxScanTuples)}`))
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)

  const distance = sql<number>`${lr.embedding} <=> ${`[${Array.from(queryVector).join(',')}]`}`
  const rows = await tx
    .select({ ...candidateColumns, distance: distance.mapWith(Number) })
    .from(lr)
    .where(and(...filterConditions(filters), isNotNull(lr.embedding)))
    .orderBy(distance)
    .limit(wanted)

  rows.sort((a, b) => a.distance - b.distance || byQualityThenId(a, b, config))
  const best = rows[0]?.distance ?? 0
  return rows
    .filter(r => r.distance <= maxDistance && (maxDistanceFromBest === null || r.distance <= best + maxDistanceFromBest))
    .map(({ distance: _distance, ...c }) => c)
}

/** Tiebreaker for equal distances: the better weighted rating first (none last), then the id, so the order is total. */
function byQualityThenId(a: Candidate, b: Candidate, config: SearchConfig): number {
  const qa = weightedRating(a, config)
  const qb = weightedRating(b, config)
  if (qa !== qb) {
    if (qa === null) return 1
    if (qb === null) return -1
    return qb - qa
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
