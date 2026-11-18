/**
 * Query plans of a real search: every statement the search sends can use its
 * index, so the cost on the real catalogue is bounded as designed
 * (docs/search.md, "Performance").
 *
 * PGlite can't measure speed, and on a small table the planner rightly prefers
 * other plans than on 74k resources. So the plans are taken:
 * - with planner statistics, as autovacuum keeps them;
 * - with sequential scans off;
 * - without lr_is_active_idx (dropped inside a transaction that's rolled back).
 *   An index on a boolean that's true for nearly every row is, on a table of
 *   a few pages, cheaper than any real lookup: the planner reads every row
 *   through it. On the real catalogue that means reading the whole table, and
 *   the GIN and HNSW indexes win. Whether production ever uses it, and whether
 *   to drop it: docs/search.md, "Tuning".
 * What this shows is that each query *can* use the intended index.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pg, queryLog, resetDb } from '../fakes/db.js'
import { embedQuery } from '../fakes/embedding.js'
import { conceptEmbedding, insertCatalogue } from '../helpers/search-catalogue.js'
import { search } from '../../src/search/search.js'

beforeEach(async () => {
  await resetDb()
  embedQuery.mockImplementation(async (text: string) => conceptEmbedding(text))
})
afterEach(async () => { await pg.exec('RESET enable_seqscan') })

/** The plan of every SELECT the search sent (the SET LOCALs and the transaction itself aren't plans). */
async function plansOf(run: () => Promise<unknown>): Promise<Array<{ sql: string; plan: string }>> {
  queryLog.length = 0
  await run()
  const statements = queryLog.filter(q => /^\s*select/i.test(q.sql))
  await pg.exec('ANALYZE learning_resources; ANALYZE search_vocabulary')
  const plans = []
  await pg.exec('BEGIN; DROP INDEX lr_is_active_idx; SET LOCAL enable_seqscan = off')
  try {
    for (const { sql, params } of statements) {
      const { rows } = await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params)
      plans.push({ sql, plan: rows.map(r => r['QUERY PLAN']).join('\n') })
    }
  } finally {
    await pg.exec('ROLLBACK')
  }
  return plans
}

describe('search query plans', () => {
  it('uses the indexes for every statement: vocabulary, keyword tiers, HNSW, results', async () => {
    await insertCatalogue()
    const plans = await plansOf(() => search({
      query: 'pyhton data analysis', sort: 'relevance', limit: 10, cursor: null,
      filters: { level: [], provider: [], language: [], resource_type: [] },
    }))

    const find = (pattern: RegExp) => {
      const found = plans.filter(p => pattern.test(p.sql))
      expect(found.length, `a statement matching ${pattern}`).toBeGreaterThan(0)
      return found
    }
    // Typo correction: the known-word check uses the primary key, the lookup both candidate indexes.
    for (const p of find(/EXISTS \(SELECT 1 FROM "search_vocabulary" v WHERE v\.word = w\.lexeme\)/)) {
      expect(p.plan).toContain('search_vocabulary_pkey')
    }
    for (const p of find(/CROSS JOIN LATERAL/)) {
      expect(p.plan).toContain('sv_word_trgm_idx')
      expect(p.plan).toContain('sv_first_letter_length_idx')
    }
    // Keyword tiers ("all words", then "any word"): the GIN index on search_document.
    const keyword = find(/"search_document" @@/)
    expect(keyword.length).toBe(2)
    for (const p of keyword) expect(p.plan).toMatch(/Bitmap Index Scan on lr_search_document_idx/)
    // Semantic candidates: an HNSW index scan, ordered by distance.
    for (const p of find(/<=>/)) expect(p.plan).toMatch(/Index Scan using lr_embedding_hnsw_idx[\s\S]*Order By: \(embedding <=> /)
    // The page's display fields: by primary key.
    for (const p of find(/"source_url"/)) expect(p.plan).toContain('learning_resources_pkey')

    for (const p of plans) expect(p.plan, p.sql).not.toMatch(/Seq Scan on (learning_resources|search_vocabulary)/)
  })

  it('with filters, still never scans the whole table', async () => {
    // The planner may use a filter's own index instead (e.g. a rare level): also
    // bounded, and for the semantic side exact. What must never happen is a full scan.
    await insertCatalogue()
    const plans = await plansOf(() => search({
      query: 'python data analysis', sort: 'rating', limit: 10, cursor: null,
      filters: { level: ['beginner'], provider: ['udemy', 'coursera'], language: [], resource_type: ['course'], is_free: false },
    }))
    expect(plans.length).toBeGreaterThanOrEqual(4)
    for (const p of plans) expect(p.plan, p.sql).not.toMatch(/Seq Scan on (learning_resources|search_vocabulary)/)
  })
})
