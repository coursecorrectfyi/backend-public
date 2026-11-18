/**
 * Sort orders over the candidate set, and keyset pagination through them.
 *
 * Every sort orders the same candidates (at most a few hundred, see
 * config.ts), so this is plain TypeScript: the same rules for every sort,
 * and testable without a database. Each sort is a list of keys, each
 * descending or ascending with NULLs last, then the id as the final
 * tiebreaker, so the order is total and a page boundary is exact.
 */
import type { SearchConfig } from './config.js'

export const SORT_KEYS = ['relevance', 'rating', 'most_reviewed', 'duration_asc', 'duration_desc', 'newest'] as const
export type SortKey = typeof SORT_KEYS[number]

/** What the search knows about each candidate resource, to fuse and order them. */
export interface Candidate {
  id: string
  /** Whether the resource has an embedding (without one it can't be a semantic match). */
  embedded: boolean
  rating: number | null
  num_ratings: number | null
  duration_hours: number | null
  /** created_at as ISO 8601 UTC with exactly six fractional digits (fixed width: it sorts as text). */
  created_at: string
}

export interface ScoredCandidate extends Candidate {
  /** Relevance: the fused score (higher is better). */
  score: number
}

export type SortValue = number | string | null

interface SortPart {
  value: (c: ScoredCandidate, config: SearchConfig) => SortValue
  direction: 'asc' | 'desc'
  /** For validating cursors: what a value of this part can be. */
  kind: 'number' | 'integer' | 'timestamp'
  nullable: boolean
}

/**
 * Bayesian average of the rating: a few ratings count for less. null without
 * a rating. A rating without a count is treated as 0 ratings (the prior wins).
 */
export function weightedRating(c: Pick<Candidate, 'rating' | 'num_ratings'>, config: SearchConfig): number | null {
  if (c.rating === null) return null
  const n = Math.max(0, c.num_ratings ?? 0)
  const { priorMean, priorCount } = config.rating
  return (n * c.rating + priorCount * priorMean) / (n + priorCount)
}

const byScore: SortPart = { value: c => c.score, direction: 'desc', kind: 'number', nullable: false }
const byWeightedRating: SortPart = { value: weightedRating, direction: 'desc', kind: 'number', nullable: true }

export const SORTS: Record<SortKey, readonly SortPart[]> = {
  // Equal relevance (common in rank fusion): the better rated resource first.
  relevance: [byScore, byWeightedRating],
  rating: [byWeightedRating],
  most_reviewed: [{ value: c => c.num_ratings, direction: 'desc', kind: 'integer', nullable: true }],
  duration_asc: [{ value: c => c.duration_hours, direction: 'asc', kind: 'number', nullable: true }],
  duration_desc: [{ value: c => c.duration_hours, direction: 'desc', kind: 'number', nullable: true }],
  newest: [{ value: c => c.created_at, direction: 'desc', kind: 'timestamp', nullable: false }],
}

/** A position in an order: the sort values and the id. Cursors store exactly this. */
export interface Position {
  values: SortValue[]
  id: string
}

export function positionOf(sort: SortKey, c: ScoredCandidate, config: SearchConfig): Position {
  return { values: SORTS[sort].map(part => part.value(c, config)), id: c.id }
}

/** Negative if `a` comes before `b` in `sort`, positive if after (never 0 for different ids). */
export function comparePositions(sort: SortKey, a: Position, b: Position): number {
  const parts = SORTS[sort]
  for (let i = 0; i < parts.length; i++) {
    const x = a.values[i] ?? null
    const y = b.values[i] ?? null
    if (x === y) continue
    if (x === null) return 1 // NULLS LAST in both directions
    if (y === null) return -1
    const cmp = x < y ? -1 : x > y ? 1 : 0
    if (cmp !== 0) return parts[i]!.direction === 'asc' ? cmp : -cmp
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The candidates in `sort` order, each with its position. */
export function orderCandidates(
  sort: SortKey,
  candidates: readonly ScoredCandidate[],
  config: SearchConfig,
): Array<{ candidate: ScoredCandidate; position: Position }> {
  return candidates
    .map(candidate => ({ candidate, position: positionOf(sort, candidate, config) }))
    .sort((a, b) => comparePositions(sort, a.position, b.position))
}
