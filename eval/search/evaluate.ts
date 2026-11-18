/** Running the golden queries, pooling results across runs, and judging what isn't judged yet. */
import { intentOf, type QueryRow } from './queries.js'
import type { JudgeConfig, JudgeFn } from './judge.js'
import type { Retriever } from './retrievers.js'
import { type ResourceDetails, toStoredResult } from './retrievers.js'
import type { EvalStore, Run, RunRow } from './store.js'

export type LoadResources = (ids: readonly string[]) => Promise<Map<string, ResourceDetails>>

/**
 * Runs every query through one retriever. Measured retrievers (the API) are
 * asked twice: the first time is timed with cold caches for that query (the
 * embedding isn't cached yet), the repeat with warm ones, and comparing the
 * two shows whether results are stable.
 */
export async function runQueries(options: {
  label: string
  rows: QueryRow[]
  retriever: Retriever
  loadResources: LoadResources
  topK?: number
  onProgress?: (done: number, total: number) => void
}): Promise<Run> {
  const { rows, retriever, loadResources } = options
  const topK = options.topK ?? 20
  const runRows: RunRow[] = []
  for (const [i, row] of rows.entries()) {
    const started = performance.now()
    const first = await retriever.retrieve(row, topK)
    const firstMs = performance.now() - started
    let repeatMs: number | null = null
    let stable: boolean | null = null
    if (retriever.measured) {
      const again = performance.now()
      const repeat = await retriever.retrieve(row, topK)
      repeatMs = performance.now() - again
      stable = repeat.status === first.status && repeat.ids.join() === first.ids.join()
    }
    const details = await loadResources(first.ids)
    runRows.push({
      key: row.key,
      status: first.status,
      results: first.ids.flatMap((id, i) => {
        const d = details.get(id)
        if (!d) return [] // gone from the database since: skip
        const distance = first.distances?.[i]
        return [distance === undefined ? toStoredResult(d) : { ...toStoredResult(d), distance }]
      }),
      first_ms: retriever.measured ? Math.round(firstMs) : null,
      repeat_ms: repeatMs === null ? null : Math.round(repeatMs),
      stable,
      vector_search: first.vector_search,
      ...(first.corrected_query !== undefined ? { corrected_query: first.corrected_query } : {}),
    })
    options.onProgress?.(i + 1, rows.length)
  }
  return { label: options.label, created_at: new Date().toISOString(), source: retriever.source, top_k: topK, rows: runRows }
}

/**
 * The judged pool of each query row: every resource any run returned for it.
 * A typo row (same_as) shares the pool of the query it stands for, since
 * its results are judged against that query.
 */
export function pools(rows: QueryRow[], runs: Run[]): Map<string, Map<string, string>> {
  const own = new Map<string, Map<string, string>>() // row key → resource key → id
  for (const row of rows) own.set(row.key, new Map())
  for (const run of runs) {
    for (const runRow of run.rows) {
      const pool = own.get(runRow.key)
      if (pool) for (const r of runRow.results) pool.set(r.key, r.id)
    }
  }
  const result = new Map<string, Map<string, string>>()
  for (const row of rows) {
    const pool = new Map(own.get(row.key))
    if (row.expect.type === 'same_as') {
      for (const [key, id] of own.get(row.expect.query) ?? []) pool.set(key, id)
    }
    result.set(row.key, pool)
  }
  return result
}

export interface PendingPair { intent: string; resource: string; id: string }

/** Pairs in the pool that this judge configuration hasn't graded yet (human overrides also count as graded). */
export function pendingPairs(rows: QueryRow[], runs: Run[], store: EvalStore, config: JudgeConfig): PendingPair[] {
  const judged = store.judgedBy(config)
  const overridden = new Set(store.overrides().map(o => `${o.intent}\u0000${o.resource}`))
  const pending = new Map<string, PendingPair>()
  const poolByRow = pools(rows, runs)
  for (const row of rows) {
    const intent = intentOf(row)
    if (intent === null) continue // should have no results: nothing to judge
    for (const [resource, id] of poolByRow.get(row.key)!) {
      const key = `${intent}\u0000${resource}`
      if (!judged(intent, resource) && !overridden.has(key)) pending.set(key, { intent, resource, id })
    }
  }
  return [...pending.values()]
}

/** Runs `fn` over `items` with at most `limit` at a time. */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

function isRateLimit(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  return /429|RESOURCE_EXHAUSTED/.test(text)
}

/**
 * Grades the given pairs and appends each judgment to the store as soon as
 * it's made (an interrupted run loses nothing). A pair that keeps failing is
 * skipped and reported: it stays pending for the next run.
 */
export async function judgePairs(options: {
  pairs: PendingPair[]
  store: EvalStore
  config: JudgeConfig
  judge: JudgeFn
  loadResources: LoadResources
  concurrency?: number
  retryDelayMs?: number
  onProgress?: (done: number, total: number) => void
}): Promise<{ judged: number; failed: Array<PendingPair & { error: string }> }> {
  const { pairs, store, config, judge } = options
  const details = await options.loadResources(pairs.map(p => p.id))
  const failed: Array<PendingPair & { error: string }> = []
  let done = 0
  let judged = 0
  const retryDelayMs = options.retryDelayMs ?? 2_000
  await mapLimit(pairs, options.concurrency ?? 8, async pair => {
    const resource = details.get(pair.id)
    if (!resource) {
      failed.push({ ...pair, error: 'resource no longer in the database' })
    } else {
      for (let attempt = 0; ; attempt++) {
        try {
          const verdict = await judge(pair.intent, resource)
          store.appendJudgment({
            intent: pair.intent, resource: pair.resource, id: pair.id, title: resource.title,
            grade: verdict.grade, reason: verdict.reason,
            model: config.model, prompt_version: config.promptVersion, judged_at: new Date().toISOString(),
          })
          judged++
          break
        } catch (err) {
          if (attempt >= 3) {
            failed.push({ ...pair, error: err instanceof Error ? err.message : String(err) })
            break
          }
          await new Promise(r => setTimeout(r, retryDelayMs * (isRateLimit(err) ? 3 : 1) * 2 ** attempt))
        }
      }
    }
    options.onProgress?.(++done, pairs.length)
  })
  return { judged, failed }
}
