/**
 * Stand-in for src/db/client.ts, backed by PGlite (Postgres compiled to WASM,
 * running in-process) with the pgvector extension.
 *
 * The schema comes from the real migrations/*.sql files, so tests cover the
 * hand-written SQL too (pgvector extension, HNSW index, search_document trigger).
 * Full-text search, vector distance, upserts and CURRENT_DATE all run on a real
 * Postgres engine, not a query-builder mock.
 */
import { inject } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import type { PGlite } from '@electric-sql/pglite'
import * as schema from '../../src/db/schema.js'
import { singleton } from '../helpers/singleton.js'
import { createMigratedDatabase, loadSnapshot } from './pglite.js'

export const pg: PGlite = await singleton('pglite', () => {
  const snapshot = inject('pgliteSnapshotPath')
  return snapshot ? loadSnapshot(snapshot) : createMigratedDatabase()
})
export const db = singleton('drizzle', () => drizzle(pg, { schema }))
export type DB = typeof db

/** Production drains the connection pool; the in-process database needs no cleanup. */
export async function closeDb(): Promise<void> {}

/**
 * Empties every table. Call in beforeEach for test isolation.
 *
 * Uses DELETE rather than TRUNCATE (about 3ms vs 95ms per call in PGlite).
 * Turning off replication-role triggers skips foreign-key checks, so the tables
 * can be emptied in any order. No table uses a sequence, so there is no
 * identity to restart.
 */
export async function resetDb(): Promise<void> {
  const tables = await singleton('tables', async () => {
    const { rows } = await pg.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    )
    return rows.map(r => r.tablename)
  })
  await pg.exec(
    `SET session_replication_role = replica;
     ${tables.map(t => `DELETE FROM "${t}";`).join('\n')}
     SET session_replication_role = DEFAULT;`,
  )
}
