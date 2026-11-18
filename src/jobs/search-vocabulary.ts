/**
 * Rebuilds the search vocabulary (typo correction, src/search/vocabulary.ts)
 * from the active catalogue.
 *
 * The embed job does this at its end. Run this on its own after the migration
 * that creates the table (0008), or after changing the catalogue without
 * running the embed job (e.g. deactivating resources).
 *
 * Required env vars: DATABASE_URL
 *
 * Usage:
 *   npm run search:vocabulary
 *
 * Exit code 1 on failure, so a Cloud Run execution is marked as failed.
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { closeDb, db } from '../db/client.js'
import { log, logError } from '../lib/logger.js'
import { refreshVocabulary } from '../search/vocabulary.js'

/** Runs the job once and returns the process exit code. */
export async function main(): Promise<number> {
  try {
    const startedAt = Date.now()
    const { words } = await refreshVocabulary(db)
    log({ event: 'search_vocabulary_refreshed', words, duration_ms: Date.now() - startedAt })
    return 0
  } catch (err) {
    logError('search_vocabulary_failed', err)
    return 1
  } finally {
    await closeDb()
  }
}

// Run only when executed directly, not when imported by tests.
/* v8 ignore next 3 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
