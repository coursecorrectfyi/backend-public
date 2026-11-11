/**
 * Job 3: Embeddings Backfill — entry point for the Cloud Run Job.
 *
 * Processes all learning_resources rows where embedding IS NULL.
 * For each row, builds the embedding input string, calls Vertex AI
 * text-embedding-004 in batches, and writes the 768-dim vector back to the DB.
 *
 * Design:
 *   - Keyset pagination keeps memory bounded.
 *   - API calls are batched (up to 100 per request) to minimise latency.
 *   - DB writes within each batch run in parallel.
 *   - Single pass: exits when no unembedded rows remain. Re-run to pick up
 *     rows added after this job started.
 *
 * Required env vars:
 *   DATABASE_URL           — postgres connection string
 *   GOOGLE_CLOUD_PROJECT   — GCP project ID (default: your-gcp-project-id)
 *
 * Optional env vars:
 *   DRY_RUN_LIMIT          — process at most N rows (for testing)
 *   PROVIDER               — only process rows for this provider (for testing)
 *
 * Usage:
 *   npx tsx src/jobs/embed.ts
 *   DRY_RUN_LIMIT=20 PROVIDER=coursera npx tsx src/jobs/embed.ts
 */

import 'dotenv/config'
import { isNull, eq, and, gt, asc } from 'drizzle-orm'
import { db, closeDb } from '../db/client.js'
import { learning_resources } from '../db/schema.js'
import { log } from '../lib/logger.js'
import {
  buildEmbeddingInput,
  embedBatch,
  EMBEDDING_BATCH_SIZE,
} from '../lib/embedding/vertex.js'

// Rows fetched from DB per page. Large because there is no heavy
// per-row compute — the bottleneck is the batched API call, not row loading.
const DB_PAGE_SIZE = 500

async function main() {
  const dryRunLimit = process.env.DRY_RUN_LIMIT
    ? parseInt(process.env.DRY_RUN_LIMIT, 10)
    : undefined
  const providerFilter = process.env.PROVIDER ?? null

  log({ event: 'embedding_job_start', dry_run_limit: dryRunLimit ?? null, provider: providerFilter })

  const counts = { success: 0, failed: 0, truncated: 0 }
  let cursor: string | null = null
  let totalProcessed = 0

  while (true) {
    if (dryRunLimit && totalProcessed >= dryRunLimit) break

    const pageLimit = dryRunLimit
      ? Math.min(DB_PAGE_SIZE, dryRunLimit - totalProcessed)
      : DB_PAGE_SIZE

    // Fetch a page of rows that still need embeddings.
    const conditions = [isNull(learning_resources.embedding)]
    if (providerFilter) conditions.push(eq(learning_resources.provider, providerFilter))
    if (cursor) conditions.push(gt(learning_resources.id, cursor))

    const page = await db
      .select({
        id: learning_resources.id,
        title: learning_resources.title,
        provider_type: learning_resources.provider_type,
        institution: learning_resources.institution,
        level: learning_resources.level,
        skills: learning_resources.skills,
        ai_summary: learning_resources.ai_summary,
      })
      .from(learning_resources)
      .where(and(...conditions))
      .orderBy(asc(learning_resources.id))
      .limit(pageLimit)

    if (page.length === 0) break

    // Process page in batches of EMBEDDING_BATCH_SIZE.
    // Each batch is one Vertex AI API call followed by parallel DB writes.
    for (let i = 0; i < page.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = page.slice(i, i + EMBEDDING_BATCH_SIZE)
      await processBatch(batch, counts)
    }

    totalProcessed += page.length
    cursor = page[page.length - 1].id

    log({
      event: 'embedding_progress',
      processed: totalProcessed,
      ...counts,
      provider: providerFilter,
    })

    if (page.length < pageLimit) break
  }

  log({ event: 'embedding_job_complete', total_processed: totalProcessed, ...counts })
  await closeDb()
}

async function processBatch(
  batch: Array<{
    id: string
    title: string
    provider_type: string | null
    institution: string | null
    level: string | null
    skills: string[] | null
    ai_summary: string | null
  }>,
  counts: { success: number; failed: number; truncated: number },
): Promise<void> {
  const inputs = batch.map(buildEmbeddingInput)

  let results
  try {
    results = await embedBatch(inputs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log({ event: 'batch_embedding_error', error: msg, batch_size: batch.length }, 'error')
    counts.failed += batch.length
    return
  }

  // Write embeddings back to DB in parallel.
  const now = new Date()
  await Promise.all(
    batch.map((row, j) => {
      const result = results[j]
      if (result.truncated) counts.truncated++
      return db
        .update(learning_resources)
        .set({ embedding: result.values, updated_at: now })
        .where(eq(learning_resources.id, row.id))
    }),
  )

  counts.success += batch.length

  log({
    event: 'batch_embedded',
    batch_size: batch.length,
    truncated_in_batch: results.filter(r => r.truncated).length,
  })
}

main().catch(err => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      ts: new Date().toISOString(),
      event: 'unhandled_error',
      error: String(err),
      cause: err instanceof Error && err.cause
        ? String((err.cause as Error).message ?? err.cause)
        : undefined,
    }) + '\n',
  )
  process.exit(1)
})
