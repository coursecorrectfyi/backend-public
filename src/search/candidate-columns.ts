/** The columns every candidate query selects (see Candidate in ordering.ts), and SQL shared by them. */
import { sql } from 'drizzle-orm'
import { learning_resources as lr } from '../db/schema.js'
import type { SearchConfig } from './config.js'

/** Narrow on purpose: only what fusion and ordering need. Display fields are fetched for the page only. */
export const candidateColumns = {
  id: lr.id,
  embedded: sql<boolean>`(${lr.embedding} IS NOT NULL)`.as('embedded'),
  rating: lr.rating,
  num_ratings: lr.num_ratings,
  duration_hours: lr.duration_hours,
  // Fixed width with microseconds, so it sorts as text and keeps Postgres's full precision in cursors.
  created_at: sql<string>`to_char(${lr.created_at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('created_at'),
}

/**
 * weightedRating() (ordering.ts) in SQL, for ordering inside a query. The two
 * must agree: test/search/ordering.test.ts checks them against each other.
 */
export function weightedRatingSql(config: SearchConfig) {
  const { priorMean, priorCount } = config.rating
  return sql<number | null>`(
    (GREATEST(COALESCE(${lr.num_ratings}, 0), 0) * ${lr.rating} + ${priorCount}::float8 * ${priorMean}::float8)
    / (GREATEST(COALESCE(${lr.num_ratings}, 0), 0) + ${priorCount}::float8)
  )`
}
