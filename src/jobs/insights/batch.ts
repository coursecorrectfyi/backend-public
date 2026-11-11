/**
 * M9.3 — Batch AI Insights Generation — Cloud Run Job entry point.
 *
 * Ranks all active learning_resources by rating × ln(num_ratings + 1),
 * takes the top TOP_N, and runs generateInsights() on any that don't
 * already have ai_insights.
 *
 * Required env vars:
 *   DATABASE_URL           — postgres connection string
 *   GOOGLE_CLOUD_PROJECT   — GCP project ID (default: your-gcp-project-id)
 *
 * Optional env vars:
 *   DRY_RUN_LIMIT          — process at most N resources (for testing)
 *   TOP_N                  — how many top-ranked resources to consider (default: 20000)
 *   CONCURRENCY            — parallel Gemini calls (default: 10)
 *   BATCH_DELAY_MS         — ms to wait between batches (default: 200; helps avoid 429 bursts)
 *
 * Usage:
 *   npm run insights:batch
 *   DRY_RUN_LIMIT=50 npm run insights:batch
 */

import 'dotenv/config'
import { isNull, desc, sql, and, eq } from 'drizzle-orm'
import { db, closeDb } from '../../db/client.js'
import { learning_resources } from '../../db/schema.js'
import { generateInsights } from './generate.js'
import { DailyQuotaExhaustedError } from './errors.js'
import { log } from '../../lib/logger.js'

const TOP_N = parseInt(process.env.TOP_N ?? '20000', 10)
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '10', 10)
const BATCH_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS ?? '200', 10)
const DRY_RUN_LIMIT = process.env.DRY_RUN_LIMIT ? parseInt(process.env.DRY_RUN_LIMIT, 10) : undefined
// Exit if this many consecutive resources fail with non-quota errors (systematic error)
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.MAX_CONSECUTIVE_ERRORS ?? '5', 10)

async function main() {
  log({ event: 'insights_batch_start', top_n: TOP_N, concurrency: CONCURRENCY, dry_run_limit: DRY_RUN_LIMIT ?? null })

  // Fetch top-ranked resources that don't yet have ai_insights.
  // Ranking: rating × ln(num_ratings + 1) — balances quality and popularity.
  // Only active resources; skip anything already generated.
  const candidates = await db
    .select({ id: learning_resources.id, title: learning_resources.title })
    .from(learning_resources)
    .where(and(
      eq(learning_resources.is_active, true),
      isNull(learning_resources.ai_insights),
    ))
    .orderBy(desc(sql`
      COALESCE(${learning_resources.rating}, 0)
      * LN(COALESCE(${learning_resources.num_ratings}, 0) + 1)
    `))
    .limit(DRY_RUN_LIMIT ?? TOP_N)

  const total = candidates.length
  log({ event: 'insights_batch_candidates', total })

  if (total === 0) {
    log({ event: 'insights_batch_nothing_to_do' })
    await closeDb()
    return
  }

  const counts = { success: 0, failed: 0 }
  let consecutiveErrors = 0
  let exitReason = 'completed'

  // Process in concurrent batches of CONCURRENCY.
  // Exit early on daily quota exhaustion or too many consecutive errors.
  outer: for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)

    await Promise.all(batch.map(async ({ id, title }) => {
      try {
        await generateInsights(id)
        counts.success++
        consecutiveErrors = 0
      } catch (err) {
        if (err instanceof DailyQuotaExhaustedError) {
          exitReason = 'quota_exhausted'
          log({ event: 'insights_batch_quota_exhausted', processed: counts.success }, 'warn')
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        log({ event: 'insights_batch_row_failed', resource_id: id, title, error: msg }, 'error')
        counts.failed++
        consecutiveErrors++
      }
    }))

    if (exitReason === 'quota_exhausted') break outer

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      exitReason = 'too_many_errors'
      log({ event: 'insights_batch_too_many_errors', consecutive: consecutiveErrors }, 'error')
      break outer
    }

    const processed = Math.min(i + CONCURRENCY, total)
    const remaining = total - processed
    log({ event: 'insights_batch_progress', processed, total, remaining, ...counts })

    if (remaining > 0) await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
  }

  log({ event: 'insights_batch_complete', exit_reason: exitReason, total, ...counts })
  await closeDb()
}

main().catch(err => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      ts: new Date().toISOString(),
      event: 'insights_batch_fatal',
      error: String(err),
    }) + '\n'
  )
  process.exit(1)
})
