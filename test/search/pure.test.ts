/** src/search: the parts without a database (ordering, weighted rating, cursor, fusion, typo limits). */
import { describe, expect, it } from 'vitest'
import { SEARCH_CONFIG } from '../../src/search/config.js'
import { encodeCursor, parseCursor, type Cursor } from '../../src/search/cursor.js'
import { fuse } from '../../src/search/fusion.js'
import {
  comparePositions, orderCandidates, positionOf, weightedRating, SORT_KEYS, type Candidate, type ScoredCandidate,
} from '../../src/search/ordering.js'
import { tsqueryOf } from '../../src/search/query.js'
import { maxEditsFor } from '../../src/search/vocabulary.js'

/** Fixed ids (ordered by n), so ties are broken the same way on every run. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const candidate = (n: number, overrides: Partial<ScoredCandidate> = {}): ScoredCandidate => ({
  id: id(n), embedded: true, rating: null, num_ratings: null, duration_hours: null,
  created_at: '2025-01-01T00:00:00.000000Z', score: 0, ...overrides,
})

describe('weightedRating', () => {
  const { priorMean, priorCount } = SEARCH_CONFIG.rating

  it('is the Bayesian average of the rating and the prior', () => {
    expect(weightedRating({ rating: 4.8, num_ratings: 20_000 }, SEARCH_CONFIG))
      .toBeCloseTo((20_000 * 4.8 + priorCount * priorMean) / (20_000 + priorCount), 12)
  })

  it('lets many ratings outweigh a perfect score from one', () => {
    const popular = weightedRating({ rating: 4.8, num_ratings: 20_000 }, SEARCH_CONFIG)!
    const single = weightedRating({ rating: 5, num_ratings: 1 }, SEARCH_CONFIG)!
    expect(popular).toBeGreaterThan(single)
  })

  it('is null without a rating, and the prior without a count (or a negative one)', () => {
    expect(weightedRating({ rating: null, num_ratings: 100 }, SEARCH_CONFIG)).toBeNull()
    expect(weightedRating({ rating: 3, num_ratings: null }, SEARCH_CONFIG)).toBe(priorMean)
    expect(weightedRating({ rating: 3, num_ratings: -5 }, SEARCH_CONFIG)).toBe(priorMean)
  })
})

describe('ordering', () => {
  it('puts NULLs last in both directions and breaks ties by id', () => {
    const list = [
      candidate(3, { duration_hours: null }), candidate(1, { duration_hours: 5 }),
      candidate(2, { duration_hours: 5 }), candidate(4, { duration_hours: 1 }), candidate(0, { duration_hours: null }),
    ]
    const ids = (sort: 'duration_asc' | 'duration_desc') => orderCandidates(sort, list, SEARCH_CONFIG).map(o => o.candidate.id)
    expect(ids('duration_asc')).toEqual([id(4), id(1), id(2), id(0), id(3)])
    expect(ids('duration_desc')).toEqual([id(1), id(2), id(4), id(0), id(3)])
  })

  it('relevance: score first, then the weighted rating (no rating last), then id', () => {
    const list = [
      candidate(1, { score: 0.02 }),
      candidate(2, { score: 0.03, rating: 4, num_ratings: 10 }),
      candidate(3, { score: 0.03, rating: 4.9, num_ratings: 10_000 }),
      candidate(4, { score: 0.03 }),
    ]
    expect(orderCandidates('relevance', list, SEARCH_CONFIG).map(o => o.candidate.id)).toEqual([id(3), id(2), id(4), id(1)])
  })

  it('newest: compares microsecond timestamps as text', () => {
    const list = [
      candidate(1, { created_at: '2025-01-01T00:00:00.000001Z' }),
      candidate(2, { created_at: '2025-01-01T00:00:00.000002Z' }),
      candidate(3, { created_at: '2024-12-31T23:59:59.999999Z' }),
    ]
    expect(orderCandidates('newest', list, SEARCH_CONFIG).map(o => o.candidate.id)).toEqual([id(2), id(1), id(3)])
  })

  it.each(SORT_KEYS)('%s is a total order: every pair compares the same both ways, never equal', sort => {
    const list = Array.from({ length: 12 }, (_, n) => candidate(n, {
      score: [0.01, 0.02][n % 2]!, rating: [null, 4, 4.5][n % 3]!, num_ratings: [null, 10, 10][n % 3]!,
      duration_hours: [null, 2, 2, 8][n % 4]!, created_at: `2025-01-0${1 + (n % 3)}T00:00:00.000000Z`,
    }))
    for (const a of list) {
      for (const b of list) {
        const ab = comparePositions(sort, positionOf(sort, a, SEARCH_CONFIG), positionOf(sort, b, SEARCH_CONFIG))
        const ba = comparePositions(sort, positionOf(sort, b, SEARCH_CONFIG), positionOf(sort, a, SEARCH_CONFIG))
        if (a.id === b.id) expect(ab).toBe(0)
        else { expect(ab).not.toBe(0); expect(Math.sign(ab)).toBe(-Math.sign(ba)) }
      }
    }
  })
})

describe('cursor', () => {
  const ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a60'

  it('round-trips a position exactly (scores are doubles; JSON keeps every bit)', () => {
    const score = 1 / 61 + 1 / 63
    const cursor: Cursor = { v: 2, sort: 'relevance', mode: 'hybrid', values: [score, 4.612345678901234], id: ID }
    expect(parseCursor(encodeCursor(cursor), 'relevance', 1000)).toEqual(cursor)
  })

  it('lowercases the id (Postgres sorts uuids by their lowercase hex form)', () => {
    const token = encodeCursor({ v: 2, sort: 'rating', mode: 'keyword', values: [null], id: ID.toUpperCase() })
    expect(parseCursor(token, 'rating', 1000)?.id).toBe(ID)
  })

  it('refuses a cursor over the length limit, or for another sort', () => {
    const token = encodeCursor({ v: 2, sort: 'rating', mode: 'hybrid', values: [4.5], id: ID })
    expect(parseCursor(token, 'rating', token.length - 1)).toBeNull()
    expect(parseCursor(token, 'newest', 1000)).toBeNull()
  })
})

describe('fusion (reciprocal rank fusion)', () => {
  const k = 60

  it('adds 1 / (k + rank) for each list a resource is in', () => {
    const a = candidate(1), b = candidate(2), c = candidate(3)
    const scores = Object.fromEntries(fuse([a, b], [b, c], k).map(s => [s.id, s.score]))
    expect(scores).toEqual({ [a.id]: 1 / 61, [b.id]: 1 / 62 + 1 / 61, [c.id]: 1 / 62 })
  })

  it('gives a resource without an embedding its keyword rank on the semantic side too (hybrid mode only)', () => {
    const unembedded = candidate(1, { embedded: false })
    const both = candidate(2)
    const hybrid = Object.fromEntries(fuse([unembedded, both], [both], k).map(s => [s.id, s.score]))
    expect(hybrid[unembedded.id]).toBe(2 / 61)
    expect(hybrid[unembedded.id]).toBeGreaterThan(hybrid[both.id]!) // the best keyword match isn't buried
    const keywordOnly = Object.fromEntries(fuse([unembedded, both], null, k).map(s => [s.id, s.score]))
    expect(keywordOnly).toEqual({ [unembedded.id]: 1 / 61, [both.id]: 1 / 62 })
  })

  it('keeps each candidate once with its fields', () => {
    const c = candidate(1, { rating: 4.2 })
    expect(fuse([c], [c], k)).toEqual([{ ...c, score: 2 / 61 }])
  })

  it('returns nothing for two empty lists', () => {
    const none: Candidate[] = []
    expect(fuse(none, none, k)).toEqual([])
  })
})

describe('tsqueryOf', () => {
  it('quotes each lexeme, escaping quotes and backslashes', () => {
    expect(tsqueryOf(['python', 'data'], '&')).toBe("'python' & 'data'")
    expect(tsqueryOf(["o'reilli", 'a\\b'], '|')).toBe("'o''reilli' | 'a\\\\b'")
  })
})

describe('maxEditsFor', () => {
  it('follows the configured lengths: none below the minimum', () => {
    expect(['sql', 'java', 'react', 'python', 'javascript'].map(w => maxEditsFor(w, SEARCH_CONFIG))).toEqual([0, 1, 1, 2, 2])
  })
})
