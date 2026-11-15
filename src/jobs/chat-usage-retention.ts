/**
 * chat_usage retention — entry point for the Cloud Run Job (run daily by
 * Cloud Scheduler, docs/deployment-gcp.md §3). Logic and rules are in
 * src/lib/chat-usage-retention.ts.
 *
 * Optional env vars:
 *   CHAT_USAGE_RETENTION_DAYS — days of raw rows to keep (default 7, at least 2)
 *
 * Usage:
 *   npm run retention:chat-usage
 *
 * Exit code 1 on failure, so Cloud Run marks the execution as failed (and the
 * log alert in docs/monitoring.md §5 fires).
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { closeDb } from '../db/client.js'
import { log, logError } from '../lib/logger.js'
import { readRetentionDays, runChatUsageRetention } from '../lib/chat-usage-retention.js'

/** Runs the job once and returns the process exit code. */
export async function main(): Promise<number> {
  try {
    const retentionDays = readRetentionDays()
    const result = await runChatUsageRetention(retentionDays)
    log({
      event: 'chat_usage_retention',
      retention_days: retentionDays,
      summary_rows: result.summaryRows,
      deleted_rows: result.deletedRows,
    })
    return 0
  } catch (err) {
    logError('chat_usage_retention_failed', err)
    return 1
  } finally {
    await closeDb()
  }
}

// Run only when executed directly (node dist/jobs/chat-usage-retention.js), not when imported by tests.
// Runs in a child process in the tests ("job as a real process"), which coverage doesn't see.
/* v8 ignore next 3 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
