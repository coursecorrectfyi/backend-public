/**
 * GET /health: is the API up and can it reach the database?
 *
 * The database check is cached briefly and bounded in time, a common pattern
 * for dependency health checks:
 *
 * - Cached for HEALTH_CACHE_MS (5 s) per instance, both "healthy" and
 *   "unhealthy", and simultaneous requests share one check. Anyone can call
 *   /health, so without this every call is a database round trip; with it, at
 *   most one per instance every 5 seconds. An outage shows up at most 5 s late,
 *   which doesn't matter for an uptime check every few minutes.
 * - Bounded by DB_CHECK_TIMEOUT_MS (3 s). When the database hangs rather than
 *   refusing connections, a plain query would hold each /health request for
 *   the connection timeout (30 s with postgres.js) or until Cloud Run's
 *   request timeout. Now it answers 503 within 3 s.
 * - While a query from an earlier check is still hanging, later checks report
 *   "unhealthy" without sending another one, so a stuck database doesn't
 *   collect a pile of health queries.
 * - One structured error log per failed check, not per request.
 */

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { registerInstanceState } from '../lib/instance-state.js'
import { logError } from '../lib/logger.js'

export const HEALTH_CACHE_MS = 5_000
export const DB_CHECK_TIMEOUT_MS = 3_000

export class DatabaseCheckTimeout extends Error {
  constructor() {
    super(`database did not answer SELECT 1 within ${DB_CHECK_TIMEOUT_MS} ms`)
    this.name = 'DatabaseCheckTimeout'
  }
}

let lastResult: { healthy: boolean; at: number } | null = null
let running: Promise<boolean> | null = null
let queryPending = false

registerInstanceState(() => {
  lastResult = null
  running = null
  queryPending = false
})

async function checkDatabase(): Promise<boolean> {
  // An earlier query still hasn't answered: the database is stuck. Don't add another.
  if (queryPending) return false

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Promise.resolve also turns a synchronous throw into a caught failure, and
    // the pending flag is only set once there is a query to clear it.
    const query = Promise.resolve(db.execute(sql`SELECT 1`))
    queryPending = true
    query.then(() => { queryPending = false }, () => { queryPending = false })

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DatabaseCheckTimeout()), DB_CHECK_TIMEOUT_MS)
    })
    await Promise.race([query, timeout])
    return true
  } catch (err) {
    // Log the details; don't send them (hosts, usernames) from a public endpoint.
    logError('health_check_failed', err)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Whether the database answers, from the cache or a new (shared) check. */
export async function databaseHealthy(): Promise<boolean> {
  if (lastResult && Date.now() - lastResult.at < HEALTH_CACHE_MS) return lastResult.healthy
  running ??= checkDatabase()
    .then((healthy) => {
      lastResult = { healthy, at: Date.now() }
      return healthy
    })
    .finally(() => { running = null })
  return running
}

export const healthRouter = new Hono()

healthRouter.get('/', async (c) => {
  if (await databaseHealthy()) return c.json({ status: 'ok' })
  return c.json({ status: 'error', message: 'Database unavailable' }, 503)
})
