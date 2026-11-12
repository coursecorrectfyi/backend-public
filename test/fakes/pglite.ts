/**
 * Creating the in-process Postgres and caching its snapshot.
 *
 * Creating a PGlite cluster and running the migrations takes about 3.5s. Loading
 * a snapshot of an already-migrated cluster takes about 1s. global-setup.ts
 * builds the snapshot once per run, and each test file's worker loads it.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))
const PGLITE_VERSION = (JSON.parse(
  readFileSync(fileURLToPath(new URL('../../node_modules/@electric-sql/pglite/package.json', import.meta.url)), 'utf8'),
) as { version: string }).version

function migrationFiles(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  return journal.entries.map(e => join(MIGRATIONS_DIR, `${e.tag}.sql`))
}

/**
 * A new PGlite cluster with pgvector and every migration applied.
 *
 * Migrations run through exec() rather than drizzle's migrator: the first
 * migration has a hand-written statement before its first statement-breakpoint.
 * postgres.js (production) accepts that, but drizzle's PGlite migrator sends each
 * chunk as a prepared statement, which rejects multi-statement chunks. exec()
 * runs the files exactly as written.
 */
export async function createMigratedDatabase(): Promise<PGlite> {
  const pg = await PGlite.create({ extensions: { vector } })
  for (const file of migrationFiles()) await pg.exec(readFileSync(file, 'utf8'))
  return pg
}

/** Loads a snapshot written by buildSnapshot(). */
export async function loadSnapshot(path: string): Promise<PGlite> {
  return PGlite.create({ extensions: { vector }, loadDataDir: new Blob([readFileSync(path)]) })
}

/**
 * Writes a migrated-database snapshot to the OS temp dir and returns its path.
 * The file name hashes the migrations and the PGlite version, so a schema
 * change or an upgrade builds a new snapshot and unchanged runs reuse the old one.
 */
export async function buildSnapshot(): Promise<string> {
  const hash = createHash('sha256').update(PGLITE_VERSION)
  for (const file of migrationFiles()) hash.update(readFileSync(file))
  const path = join(tmpdir(), `coursecorrect-test-db-${hash.digest('hex').slice(0, 16)}.tar`)
  if (existsSync(path)) return path

  const pg = await createMigratedDatabase()
  const dump = await pg.dumpDataDir('none')
  await pg.close()
  const partial = `${path}.${process.pid}.partial`
  writeFileSync(partial, Buffer.from(await dump.arrayBuffer()))
  renameSync(partial, path) // atomic, so a concurrent run never reads half a file
  return path
}

