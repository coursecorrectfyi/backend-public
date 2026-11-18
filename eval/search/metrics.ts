/**
 * Ranking metrics over graded relevance judgments (0 = not relevant … 3 = highly relevant).
 *
 * A result without a judgment is `undefined`: it counts as not relevant in
 * nDCG and precision, and shows up in judgedAt(), which should stay at 1.
 */

export type Grade = 0 | 1 | 2 | 3

/** Exponential gain: a highly relevant result is worth much more than a marginal one. */
export const gain = (grade: number) => 2 ** grade - 1

/** Discounted cumulative gain of the first `k` grades. */
export function dcg(grades: ReadonlyArray<number | undefined>, k: number): number {
  let sum = 0
  for (let i = 0; i < Math.min(k, grades.length); i++) sum += gain(grades[i] ?? 0) / Math.log2(i + 2)
  return sum
}

/**
 * nDCG@k: the ranking's DCG divided by the best possible DCG, from every
 * judged resource for the query (`pool`, any order). null when the pool has
 * nothing relevant (nothing to rank well), so it doesn't drag averages down.
 */
export function ndcg(grades: ReadonlyArray<number | undefined>, pool: ReadonlyArray<number>, k = 10): number | null {
  const ideal = dcg([...pool].sort((a, b) => b - a), k)
  return ideal === 0 ? null : dcg(grades, k) / ideal
}

/** Share of the first k positions holding a result graded at least `min` (missing results count as misses). */
export function precisionAt(grades: ReadonlyArray<number | undefined>, k = 10, min = 2): number {
  return grades.slice(0, k).filter(g => g !== undefined && g >= min).length / k
}

/** Share of the shown top-k results that have a judgment. null without results. */
export function judgedAt(grades: ReadonlyArray<number | undefined>, k = 10): number | null {
  const top = grades.slice(0, k)
  return top.length === 0 ? null : top.filter(g => g !== undefined).length / top.length
}

/**
 * How much of `target`'s top k also appears in `results`' top k (e.g. a typo
 * and its correct spelling). null when the target has no results.
 */
export function overlapAt(results: readonly string[], target: readonly string[], k = 10): number | null {
  const t = target.slice(0, k)
  if (t.length === 0) return null
  const top = new Set(results.slice(0, k))
  return t.filter(id => top.has(id)).length / t.length
}

export function mean(values: ReadonlyArray<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number')
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length
}

/** Nearest-rank percentile (p in 0–100). null for no values. */
export function percentile(values: ReadonlyArray<number | null | undefined>, p: number): number | null {
  const v = values.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
  if (v.length === 0) return null
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))]!
}

export interface Agreement {
  n: number
  /** Same grade. */
  exact: number
  /** Grades at most 1 apart. */
  within1: number
  /** Same side of "relevant" (grade ≥ 2). */
  relevant: number
  /** Quadratic weighted Cohen's kappa: 1 = perfect, 0 = chance level. null if undefined (e.g. one grade only). */
  kappa: number | null
}

/** Agreement between two graders over the same items, as [a, b] grade pairs. */
export function agreement(pairs: ReadonlyArray<readonly [number, number]>): Agreement {
  const n = pairs.length
  if (n === 0) return { n, exact: 0, within1: 0, relevant: 0, kappa: null }
  const share = (f: (a: number, b: number) => boolean) => pairs.filter(([a, b]) => f(a, b)).length / n
  const categories = 4
  const weight = (i: number, j: number) => ((i - j) ** 2) / ((categories - 1) ** 2)
  const histA = new Array<number>(categories).fill(0)
  const histB = new Array<number>(categories).fill(0)
  let observed = 0
  for (const [a, b] of pairs) {
    histA[a]!++
    histB[b]!++
    observed += weight(a, b)
  }
  let expected = 0
  for (let i = 0; i < categories; i++) {
    for (let j = 0; j < categories; j++) expected += weight(i, j) * histA[i]! * histB[j]! / n
  }
  return {
    n,
    exact: share((a, b) => a === b),
    within1: share((a, b) => Math.abs(a - b) <= 1),
    relevant: share((a, b) => (a >= 2) === (b >= 2)),
    kappa: expected === 0 ? null : 1 - observed / expected,
  }
}
