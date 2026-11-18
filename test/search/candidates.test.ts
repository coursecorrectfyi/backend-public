/** src/search: query terms, keyword and semantic candidates, and the weighted rating in SQL (PGlite). */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, pg, queryLog, resetDb } from '../fakes/db.js'
import { unitVector, vec } from '../fakes/embedding.js'
import { insertResource } from '../helpers/fixtures.js'
import { learning_resources } from '../../src/db/schema.js'
import { weightedRatingSql } from '../../src/search/candidate-columns.js'
import { SEARCH_CONFIG, type SearchConfig } from '../../src/search/config.js'
import type { SearchFilters } from '../../src/search/filters.js'
import { keywordCandidates } from '../../src/search/keyword.js'
import { weightedRating } from '../../src/search/ordering.js'
import { keywordTerms } from '../../src/search/query.js'
import { semanticCandidates } from '../../src/search/semantic.js'

beforeEach(resetDb)

/** Fixed ids (ordered by n), so ties are broken the same way on every run. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const noFilters: SearchFilters = { level: [], provider: [], language: [], resource_type: [] }
const withConfig = (section: 'keyword' | 'semantic', values: Record<string, unknown>): SearchConfig =>
  ({ ...SEARCH_CONFIG, [section]: { ...SEARCH_CONFIG[section], ...values } })

describe('keywordTerms', () => {
  it.each([
    ['learn to build websites', ['learn', 'build', 'websit']], // query order, stemmed, "to" is a stop word
    ['best python courses for beginners', ['python', 'beginn']], // generic catalogue words dropped
    ['best courses', ['best', 'cours']], // nothing but generic words: kept
    ['how to', []], // stop words only
    ['one two three four five six seven eight nine ten', ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']],
  ])('"%s" → %j', async (text, expected) => {
    expect(await keywordTerms(db, text, SEARCH_CONFIG)).toEqual(expected)
  })
})

describe('keywordCandidates', () => {
  const titles = async (ids: string[]) => {
    const rows = await db.select({ id: learning_resources.id, title: learning_resources.title }).from(learning_resources)
    const byId = new Map(rows.map(r => [r.id, r.title]))
    return ids.map(i => byId.get(i))
  }

  it('all words: a title match ranks above a summary match', async () => {
    await insertResource({ id: id(1), title: 'Intro', ai_summary: 'Python and data' })
    await insertResource({ id: id(2), title: 'Python Data' })
    const result = await keywordCandidates(db, ['python', 'data'], noFilters, withConfig('keyword', { candidates: 2 }))
    expect(result).toMatchObject({ tier: 'all', scanCapHit: false })
    expect(await titles(result.candidates.map(c => c.id))).toEqual(['Python Data', 'Intro'])
  })

  it('any word, only when "all words" finds too few: ranked by coverage, below every all-words match', async () => {
    await insertResource({ id: id(1), title: 'Python Python Python', ai_summary: 'Python python.' }) // 1 of 3 words, often
    await insertResource({ id: id(2), title: 'Python and Data' }) // 2 of 3
    await insertResource({ id: id(3), title: 'Data Analysis with Python' }) // all 3
    await insertResource({ id: id(4), title: 'Gardening' })
    const result = await keywordCandidates(db, ['python', 'data', 'analysi'], noFilters, SEARCH_CONFIG)
    expect(result.tier).toBe('any')
    expect(await titles(result.candidates.map(c => c.id))).toEqual(['Data Analysis with Python', 'Python and Data', 'Python Python Python'])
  })

  it('equal keyword scores: the better weighted rating first, then the id', async () => {
    await insertResource({ id: id(3), title: 'Python', rating: 4.9, num_ratings: 10 })
    await insertResource({ id: id(2), title: 'Python', rating: 4.7, num_ratings: 50_000 })
    await insertResource({ id: id(1), title: 'Python' })
    await insertResource({ id: id(4), title: 'Python' })
    const result = await keywordCandidates(db, ['python'], noFilters, SEARCH_CONFIG)
    expect(result.candidates.map(c => c.id)).toEqual([id(2), id(3), id(1), id(4)])
  })

  it('reads at most scanCap matches per tier and says so', async () => {
    for (let n = 1; n <= 5; n++) await insertResource({ id: id(n), title: `Python Data ${n}` })
    const capped = withConfig('keyword', { scanCap: 3 })
    expect(await keywordCandidates(db, ['python'], noFilters, capped)).toMatchObject({ tier: 'all', scanCapHit: true })
    expect((await keywordCandidates(db, ['python'], noFilters, capped)).candidates).toHaveLength(3)
    // All words capped: no "any word" tier (there are more all-words matches than were ranked).
    expect(await keywordCandidates(db, ['python', 'data'], noFilters, capped)).toMatchObject({ tier: 'all', scanCapHit: true })
    // Any word capped.
    const anyWord = await keywordCandidates(db, ['python', 'rust'], noFilters, capped)
    expect(anyWord).toMatchObject({ tier: 'any', scanCapHit: true })
    expect(anyWord.candidates).toHaveLength(3)
    expect(await keywordCandidates(db, ['python'], noFilters, withConfig('keyword', { scanCap: 10 })))
      .toMatchObject({ scanCapHit: false })
  })

  it('applies the filters and skips inactive resources', async () => {
    await insertResource({ id: id(1), title: 'Python', provider: 'edx' })
    await insertResource({ id: id(2), title: 'Python', provider: 'udemy' })
    await insertResource({ id: id(3), title: 'Python', provider: 'edx', is_active: false })
    const result = await keywordCandidates(db, ['python'], { ...noFilters, provider: ['edx'] }, SEARCH_CONFIG)
    expect(result.candidates.map(c => c.id)).toEqual([id(1)])
  })

  it('returns nothing without terms', async () => {
    await insertResource({ title: 'Python' })
    expect(await keywordCandidates(db, [], noFilters, SEARCH_CONFIG)).toEqual({ candidates: [], tier: 'none', scanCapHit: false })
  })

  it('carries what fusion and ordering need, including a microsecond created_at', async () => {
    await insertResource({
      id: id(1), title: 'Python', rating: 4.5, num_ratings: 10, duration_hours: 2.5, embedding: unitVector(0),
      created_at: new Date('2025-03-04T05:06:07.089Z'),
    })
    expect((await keywordCandidates(db, ['python'], noFilters, SEARCH_CONFIG)).candidates).toEqual([{
      id: id(1), embedded: true, rating: 4.5, num_ratings: 10, duration_hours: 2.5, created_at: '2025-03-04T05:06:07.089000Z',
    }])
  })
})

describe('semanticCandidates', () => {
  const nearest = (config: SearchConfig = SEARCH_CONFIG, filters = noFilters) =>
    db.transaction(async tx => (await semanticCandidates(tx, unitVector(0), filters, config)).map(c => c.id))

  it('returns the nearest first, within the distance floor', async () => {
    await insertResource({ id: id(1), embedding: vec({ 0: 0.8, 1: 0.6 }) }) // distance 0.2
    await insertResource({ id: id(2), embedding: unitVector(0) }) // 0
    await insertResource({ id: id(3), embedding: vec({ 0: 0.4, 1: 0.9165 }) }) // ≈ 0.6: beyond the floor (0.5)
    await insertResource({ id: id(4), embedding: null })
    expect(await nearest()).toEqual([id(2), id(1)])
  })

  it('applies the optional floor relative to the best match', async () => {
    await insertResource({ id: id(1), embedding: vec({ 0: 0.95, 1: 0.3122 }) }) // ≈ 0.05
    await insertResource({ id: id(2), embedding: vec({ 0: 0.7, 1: 0.7141 }) }) // ≈ 0.3
    expect(await nearest(withConfig('semantic', { maxDistanceFromBest: 0.1 }))).toEqual([id(1)])
    expect(await nearest(withConfig('semantic', { maxDistanceFromBest: null }))).toEqual([id(1), id(2)])
  })

  it('equal distances: the better weighted rating first, then the id', async () => {
    await insertResource({ id: id(3), embedding: unitVector(0), rating: 4.9, num_ratings: 10 })
    await insertResource({ id: id(2), embedding: unitVector(0), rating: 4.7, num_ratings: 50_000 })
    await insertResource({ id: id(1), embedding: unitVector(0) })
    await insertResource({ id: id(4), embedding: unitVector(0) })
    expect(await nearest()).toEqual([id(2), id(3), id(1), id(4)])
  })

  it('applies the filters and skips inactive resources', async () => {
    await insertResource({ id: id(1), embedding: unitVector(0), level: 'beginner' })
    await insertResource({ id: id(2), embedding: unitVector(0), level: 'advanced' })
    await insertResource({ id: id(3), embedding: unitVector(0), level: 'beginner', is_active: false })
    expect(await nearest(SEARCH_CONFIG, { ...noFilters, level: ['beginner'] })).toEqual([id(1)])
  })

  it('sets the HNSW scan parameters for its own transaction only', async () => {
    await insertResource({ id: id(1), embedding: unitVector(0) })
    queryLog.length = 0
    await nearest(withConfig('semantic', { candidates: 150, maxScanTuples: 5_000 }))
    expect(queryLog.map(q => q.sql).filter(s => s.startsWith('SET'))).toEqual([
      'SET LOCAL hnsw.ef_search = 150',
      'SET LOCAL hnsw.max_scan_tuples = 5000',
      'SET LOCAL hnsw.iterative_scan = relaxed_order',
    ])
    // ef_search is never lowered below pgvector's default (40).
    queryLog.length = 0
    await nearest(withConfig('semantic', { candidates: 10 }))
    expect(queryLog[0]!.sql).toBe('SET LOCAL hnsw.ef_search = 40')
    // Outside the transaction, the defaults are back.
    const { rows } = await pg.query<{ ef: string }>(`SELECT current_setting('hnsw.ef_search') AS ef`)
    expect(rows[0]!.ef).toBe('40')
  })

  it('takes at most `candidates` neighbours', async () => {
    for (let n = 1; n <= 5; n++) await insertResource({ id: id(n), embedding: unitVector(0) })
    expect(await nearest(withConfig('semantic', { candidates: 3 }))).toHaveLength(3)
  })
})

describe('weightedRatingSql', () => {
  it('agrees with weightedRating() (ordering.ts) to the last digit that matters', async () => {
    const cases: Array<[number | null, number | null]> = [
      [4.8, 20_000], [5, 1], [3, null], [null, 100], [4.5, 0], [2.25, 7], [4.75, -3],
    ]
    for (const [i, [rating, num_ratings]] of cases.entries()) {
      await insertResource({ id: id(i), rating, num_ratings })
      const [row] = await db.select({ value: weightedRatingSql(SEARCH_CONFIG) }).from(learning_resources)
        .where(eq(learning_resources.id, id(i)))
      const expected = weightedRating({ rating, num_ratings }, SEARCH_CONFIG)
      if (expected === null) expect(row!.value).toBeNull()
      else expect(row!.value).toBeCloseTo(expected, 12)
    }
  })
})
