import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

/**
 * A Drizzle database or transaction. The search takes it as a parameter: the
 * API passes the production client (postgres.js), the evaluation and the
 * tests may pass PGlite, whose Drizzle types differ.
 */
export type Db = PgDatabase<PgQueryResultHKT, any, any>
