/**
 * Keyword candidates, through the GIN index on search_document.
 *
 * Two tiers, cheapest and most precise first:
 *   1. all terms match ("every word"), ranked by ts_rank_cd;
 *   2. only when tier 1 found fewer than `candidates`: any term matches,
 *      ranked by how many of the terms match (coverage), then ts_rank_cd.
 *      ts_rank_cd knows nothing about how common a word is, so coverage comes
 *      first: a resource with three of the query's words beats one repeating
 *      a single word.
 * Tier 1 results always rank above tier 2 ones.
 *
 * Cost: each tier reads at most `scanCap` matching rows before ranking them.
 * Without that, a broad query would rank tens of thousands of rows. When a
 * tier hits the cap, which matches it ranked is arbitrary (the physical order
 * of the bitmap scan): `scanCapHit` reports it (search log), and
 * docs/search.md, "Tuning", explains when that calls for a code change.
 * Within equal keyword scores, the better weighted rating comes first.
 */
import { and, asc, desc, sql, type SQL } from 'drizzle-orm'
import { learning_resources as lr } from '../db/schema.js'
import { candidateColumns, weightedRatingSql } from './candidate-columns.js'
import type { SearchConfig } from './config.js'
import type { Db } from './db.js'
import { filterConditions, type SearchFilters } from './filters.js'
import type { Candidate } from './ordering.js'
import { tsqueryOf } from './query.js'

export interface KeywordCandidates {
  /** Best first. */
  candidates: Candidate[]
  /** The last tier that ran: 'none' when there were no terms (stop words only). */
  tier: 'all' | 'any' | 'none'
  /** Whether a tier read `scanCap` matches (then more matches went unranked). */
  scanCapHit: boolean
}

/**
 * One tier: at most `scanCap` rows matching `match` are read, ranked by
 * `rankBy`, and the top `limit` returned, with how many rows were read.
 */
async function tier(
  db: Db,
  options: { match: SQL; rankBy: SQL[]; filters: SearchFilters; limit: number; config: SearchConfig },
): Promise<{ rows: Candidate[]; read: number }> {
  const { scanCap } = options.config.keyword
  const matches = db
    .select({
      ...candidateColumns,
      quality: weightedRatingSql(options.config).as('quality'),
      ...Object.fromEntries(options.rankBy.map((expr, i) => [`rank${i}`, sql<number>`${expr}`.as(`rank${i}`)])),
    })
    .from(lr)
    .where(and(...filterConditions(options.filters), options.match))
    .limit(scanCap) // the cost bound: ranking happens only over these rows
    .as('matches')
  const rows = await db
    .select({
      id: matches.id, embedded: matches.embedded, rating: matches.rating, num_ratings: matches.num_ratings,
      duration_hours: matches.duration_hours, created_at: matches.created_at,
      read: sql<number>`count(*) OVER ()`.mapWith(Number),
    })
    .from(matches)
    .orderBy(
      ...options.rankBy.map((_, i) => desc(sql.identifier(`rank${i}`))),
      sql`${sql.identifier('quality')} DESC NULLS LAST`,
      asc(matches.id),
    )
    .limit(options.limit)
  return { rows: rows.map(({ read: _read, ...c }) => c), read: rows[0]?.read ?? 0 }
}

export async function keywordCandidates(
  db: Db,
  terms: readonly string[],
  filters: SearchFilters,
  config: SearchConfig,
): Promise<KeywordCandidates> {
  if (terms.length === 0) return { candidates: [], tier: 'none', scanCapHit: false }
  const { candidates: wanted, scanCap } = config.keyword
  const doc = lr.search_document
  const all = tsqueryOf(terms, '&')

  const first = await tier(db, {
    match: sql`${doc} @@ ${all}::tsquery`,
    rankBy: [sql`ts_rank_cd(${doc}, ${all}::tsquery)`],
    filters, limit: wanted, config,
  })
  // One term: "any" is the same as "all". Enough results, or the cap was hit (more
  // "all" matches exist than were ranked): no second tier.
  if (terms.length === 1 || first.read >= scanCap || first.rows.length >= wanted) {
    return { candidates: first.rows, tier: 'all', scanCapHit: first.read >= scanCap }
  }

  const any = tsqueryOf(terms, '|')
  const coverage = sql.join(terms.map(t => sql`(${doc} @@ ${tsqueryOf([t], '&')}::tsquery)::int`), sql` + `)
  const second = await tier(db, {
    // Tier 1 read every "all" match (it wasn't capped), so excluding them leaves the rest.
    match: sql`${doc} @@ ${any}::tsquery AND NOT (${doc} @@ ${all}::tsquery)`,
    rankBy: [coverage, sql`ts_rank_cd(${doc}, ${any}::tsquery)`],
    filters, limit: wanted - first.rows.length, config,
  })
  return { candidates: [...first.rows, ...second.rows], tier: 'any', scanCapHit: second.read >= scanCap }
}
