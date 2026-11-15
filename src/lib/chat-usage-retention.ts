/**
 * Retention for chat_usage (README To do, GDPR storage limitation; docs/operations.md §5).
 *
 * chat_usage only needs today and yesterday to enforce the daily limits (a
 * question near midnight is given back to its own day). Its rows hold
 * pseudonymous identifiers (Firebase UIDs, session ids, keyed IP hashes), so
 * they shouldn't be kept longer than that plus a short buffer.
 *
 * Each run, in one transaction:
 *   1. summarize every completed day still in chat_usage into chat_usage_daily
 *      (counts only, no identities). It recomputes from the raw rows, so
 *      running twice gives the same result, and days whose raw rows are gone
 *      keep their summary;
 *   2. delete raw rows older than the retention period.
 * A day's rows are always deleted together, so a summary is never computed from
 * part of a day.
 */

import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { readNonNegativeIntEnv } from './env.js'

export const DEFAULT_RETENTION_DAYS = 7
/** Yesterday's rows must stay: refunds for questions asked just before midnight update them. */
export const MIN_RETENTION_DAYS = 2

/** CHAT_USAGE_RETENTION_DAYS (default 7). Throws below MIN_RETENTION_DAYS or on invalid values. */
export function readRetentionDays(): number {
  const days = readNonNegativeIntEnv('CHAT_USAGE_RETENTION_DAYS', DEFAULT_RETENTION_DAYS)
  if (days < MIN_RETENTION_DAYS) {
    throw new Error(`CHAT_USAGE_RETENTION_DAYS must be at least ${MIN_RETENTION_DAYS} (the daily limits need yesterday), got ${days}`)
  }
  return days
}

export interface RetentionResult {
  /** chat_usage_daily rows written or refreshed */
  summaryRows: number
  /** chat_usage rows deleted */
  deletedRows: number
}

/**
 * One count from db.execute(): postgres.js (production) returns the rows as an
 * array, PGlite (tests) as { rows }.
 */
export function countOf(result: unknown): number {
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows
  return Number((rows[0] as { n: number | string }).n)
}

/** Summarizes completed days, then deletes rows older than `retentionDays` days. */
export async function runChatUsageRetention(retentionDays: number): Promise<RetentionResult> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS) {
    throw new Error(`retentionDays must be an integer of at least ${MIN_RETENTION_DAYS}, got ${retentionDays}`)
  }

  return db.transaction(async (tx) => {
    // Completed days only (today is still counting). 'global' rows are left
    // out: they are totals of the same questions. An identity whose questions
    // were all given back (count 0) didn't ask anything that day.
    const summary = await tx.execute(sql`
      WITH written AS (
        INSERT INTO chat_usage_daily (query_date, identity_type, identities, questions)
        SELECT query_date, identity_type, COUNT(*) FILTER (WHERE count > 0), COALESCE(SUM(count), 0)
        FROM chat_usage
        WHERE query_date < CURRENT_DATE AND identity_type IN ('user', 'anon', 'ip')
        GROUP BY query_date, identity_type
        ON CONFLICT (query_date, identity_type)
          DO UPDATE SET identities = EXCLUDED.identities, questions = EXCLUDED.questions
        RETURNING 1
      )
      SELECT COUNT(*) AS n FROM written`)

    const deleted = await tx.execute(sql`
      WITH removed AS (
        DELETE FROM chat_usage WHERE query_date < CURRENT_DATE - ${retentionDays}::int RETURNING 1
      )
      SELECT COUNT(*) AS n FROM removed`)

    return { summaryRows: countOf(summary), deletedRows: countOf(deleted) }
  })
}
