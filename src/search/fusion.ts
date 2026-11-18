/**
 * Reciprocal rank fusion: merges the keyword and semantic candidate lists.
 *
 * A resource's score is Σ 1 / (k + rank) over the lists it appears in
 * (rank 1 = best). Only positions matter, not the two sides' scores, which are
 * on different scales. Being near the top of both lists beats being first in
 * one.
 *
 * Resources without an embedding yet (the embedding job hasn't run for them)
 * can't be in the semantic list. In plain RRF they would lose to anything
 * found by both sides, even as the exact title match. So in hybrid mode their
 * keyword rank counts for the semantic list too. Resources that have an
 * embedding but aren't among the semantic candidates get nothing from that
 * side (standard RRF).
 */
import type { Candidate, ScoredCandidate } from './ordering.js'

export function fuse(
  keyword: readonly Candidate[],
  semantic: readonly Candidate[] | null,
  rrfK: number,
): ScoredCandidate[] {
  const fused = new Map<string, ScoredCandidate>()
  const add = (c: Candidate, score: number) => {
    const existing = fused.get(c.id)
    if (existing) existing.score += score
    else fused.set(c.id, { ...c, score })
  }
  keyword.forEach((c, i) => {
    const contribution = 1 / (rrfK + i + 1)
    add(c, semantic !== null && !c.embedded ? 2 * contribution : contribution)
  })
  semantic?.forEach((c, i) => add(c, 1 / (rrfK + i + 1)))
  return [...fused.values()]
}
