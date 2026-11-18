/**
 * Embeddings stored as halfvec (migration 0007): the column and index, the
 * migration on existing data, the query plans, and both deploy orders (new
 * code on the old column, old code on the new column).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { eq } from 'drizzle-orm'
import { db, pg, resetDb } from '../fakes/db.js'
import { embedQuery, vec } from '../fakes/embedding.js'
import { insertResource } from '../helpers/fixtures.js'
import { learning_resources } from '../../src/db/schema.js'
import { retrievalQuery, retrieveForQuery } from '../../src/api/rag.js'

beforeEach(resetDb)
afterEach(async () => { await pg.exec('RESET enable_seqscan') })

/** The plan of a query, without the (long) vector literals. */
async function plan(sqlText: string, params: unknown[] = []): Promise<string> {
  const { rows } = await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sqlText}`, params)
  return rows.map(r => r['QUERY PLAN'].replace(/'\[[^\]]*\]'/g, "'[…]'")).join('\n')
}

/** Seeded PRNG (mulberry32): the same "random" vectors on every run. */
function random(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const literal = (v: ArrayLike<number>) => `[${Array.from(v).join(',')}]`

describe('embedding column', () => {
  it('is halfvec(768), with an HNSW index using halfvec_cosine_ops (and the old vector index gone)', async () => {
    const { rows: [column] } = await pg.query<{ type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = 'learning_resources'::regclass AND attname = 'embedding'`)
    expect(column!.type).toBe('halfvec(768)')
    const { rows: indexes } = await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'learning_resources' AND indexdef ILIKE '%hnsw%'`)
    expect(indexes).toEqual([{
      indexname: 'lr_embedding_hnsw_idx',
      indexdef: 'CREATE INDEX lr_embedding_hnsw_idx ON public.learning_resources USING hnsw (embedding halfvec_cosine_ops)',
    }])
  })

  it('round-trips through Drizzle as number[] within halfvec precision', async () => {
    const values = vec({ 0: 0.123456789, 1: -0.987654321, 767: 0.000123 })
    const row = await insertResource({ embedding: values })
    const [stored] = await db.select({ embedding: learning_resources.embedding })
      .from(learning_resources).where(eq(learning_resources.id, row.id))
    expect(stored!.embedding).toHaveLength(768)
    stored!.embedding!.forEach((x, i) => expect(x).toBeCloseTo(values[i]!, 3))
  })
})

describe('migration 0007 on existing data', () => {
  it('converts stored vector embeddings, replaces the index, and keeps the nearest neighbours', async () => {
    // A database as it is before 0007 (like Cloud SQL today), with some embeddings.
    const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url))
    const journal = JSON.parse(readFileSync(`${migrationsDir}meta/_journal.json`, 'utf8')) as { entries: Array<{ tag: string }> }
    const tags = journal.entries.map(e => e.tag)
    const at = tags.indexOf('0007_halfvec_embeddings')
    expect(at).toBeGreaterThan(0)
    const old = await PGlite.create({ extensions: { vector } })
    try {
      for (const tag of tags.slice(0, at)) await old.exec(readFileSync(`${migrationsDir}${tag}.sql`, 'utf8'))
      const next = random(7)
      const vectors = Array.from({ length: 40 }, () => Array.from({ length: 768 }, () => next() * 2 - 1))
      for (const [i, v] of vectors.entries()) {
        await old.query(
          `INSERT INTO learning_resources (provider, external_id, resource_type, title, source_url, last_seen_at, embedding)
           VALUES ('udemy', $1, 'course', $1, $1, 1, $2)`, [`r${i}`, literal(v)])
      }
      const query = literal(vectors[0]!.map(x => x + 0.05))
      const nearest = async () => (await old.query<{ external_id: string }>(
        `SELECT external_id FROM learning_resources ORDER BY embedding <=> $1 LIMIT 6`, [query])).rows.map(r => r.external_id)
      const before = await nearest()

      await old.exec(readFileSync(`${migrationsDir}${tags[at]}.sql`, 'utf8'))

      const { rows: [column] } = await old.query<{ type: string }>(
        `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
         WHERE attrelid = 'learning_resources'::regclass AND attname = 'embedding'`)
      expect(column!.type).toBe('halfvec(768)')
      expect((await old.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'learning_resources_embedding_idx'`)).rows).toEqual([])
      expect(await nearest()).toEqual(before)
      const { rows: [stored] } = await old.query<{ embedding: string }>(`SELECT embedding::text FROM learning_resources WHERE external_id = 'r3'`)
      ;(JSON.parse(stored!.embedding) as number[]).forEach((x, i) => expect(x).toBeCloseTo(vectors[3]![i]!, 2))
    } finally {
      await old.close()
    }
  })
})

describe('query plans: the HNSW index', () => {
  beforeEach(async () => {
    // On a small table the planner rightly prefers a sequential scan; forcing it off
    // shows whether the query *can* use the index, as it must on the real catalogue.
    await pg.exec('SET enable_seqscan = off')
  })

  it('chat retrieval (RAG) orders by the HNSW index, also when excluding page-context ids', async () => {
    for (const exclude of [[], ['00000000-0000-4000-8000-000000000001']]) {
      const { sql, params } = retrievalQuery(vec({ 0: 1 }), 6, exclude).toSQL()
      expect(await plan(sql, params)).toMatch(/Index Scan using lr_embedding_hnsw_idx[\s\S]*Order By: \(embedding <=> /)
    }
  })

  it('the previous release (a ::vector literal) still uses the new index: rolling back after the migration is safe', async () => {
    const oldQuery = `SELECT id FROM learning_resources WHERE is_active = true AND embedding IS NOT NULL
                      ORDER BY embedding <=> '${literal(vec({ 0: 1 }))}'::vector LIMIT 6`
    expect(await plan(oldQuery)).toContain('Index Scan using lr_embedding_hnsw_idx')
  })

  it('this release (an uncast parameter) uses a vector index on a vector column: deploying before the migration is safe', async () => {
    await pg.exec(`CREATE TEMP TABLE before_migration (id int, embedding vector(3));
                   CREATE INDEX before_migration_idx ON before_migration USING hnsw (embedding vector_cosine_ops);`)
    try {
      expect(await plan(`SELECT id FROM before_migration ORDER BY embedding <=> $1 LIMIT 6`, ['[1,0,0]']))
        .toContain('Index Scan using before_migration_idx')
      // Whereas casting to halfvec would quietly compute every distance (no index):
      expect(await plan(`SELECT id FROM before_migration ORDER BY embedding <=> $1::halfvec LIMIT 6`, ['[1,0,0]']))
        .toContain('Seq Scan')
    } finally {
      await pg.exec('DROP TABLE before_migration')
    }
  })
})

describe('ranking on halfvec', () => {
  it('returns the same nearest neighbours as exact float64 math (seeded random catalogue, 10 queries)', async () => {
    const next = random(42)
    const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n) }
    // 60 resources: each insert also updates the HNSW graph, which is slow in PGlite.
    const vectors = Array.from({ length: 60 }, () => unit(Array.from({ length: 768 }, () => next() * 2 - 1)))
    const rows = await db.insert(learning_resources).values(vectors.map((v, i) => ({
      provider: 'udemy', external_id: `r${i}`, resource_type: 'course' as const, title: `R${i}`,
      source_url: `https://provider.example/r${i}`, last_seen_at: 1, embedding: v,
    }))).returning({ id: learning_resources.id })

    for (let q = 0; q < 10; q++) {
      // A query near one resource, so the top results are close together (the hard case for rounding).
      const query = unit(vectors[q * 6]!.map(x => x + (next() * 2 - 1) * 0.05))
      const exact = rows
        .map((r, i) => ({ id: r.id, similarity: vectors[i]!.reduce((s, x, d) => s + x * query[d]!, 0) }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 6)
        .map(r => r.id)
      embedQuery.mockResolvedValue(query)
      expect((await retrieveForQuery('q', 6)).map(r => r.id)).toEqual(exact)
    }
  })
})
