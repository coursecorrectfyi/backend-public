/**
 * The evaluation's commands, with their dependencies passed in (cli.ts wires
 * the real database, API, embedding and judge; the tests wire PGlite, the
 * in-process app and a fake judge).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { calibrationCsv, calibrationSample, kindLookup, readCalibrationCsv, renderCalibration, scoreCalibration } from './calibration.js'
import { judgePairs, pendingPairs, runQueries, type LoadResources } from './evaluate.js'
import type { JudgeConfig, JudgeFn } from './judge.js'
import { parseQueries, type QueryRow } from './queries.js'
import { computeReport, renderReport } from './report.js'
import type { Retriever } from './retrievers.js'
import { EvalStore } from './store.js'

export const SEED_RUNS = {
  keywordAny: 'seed-keyword-any',
  semantic: 'seed-semantic',
} as const

export interface Context {
  store: EvalStore
  rows: QueryRow[]
  judgeConfig: JudgeConfig
  /** Progress and notes (stderr in the CLI). */
  note: (message: string) => void
}

export function loadContext(dir: string, judgeConfig: JudgeConfig, note: (message: string) => void): Context {
  const rows = parseQueries(readFileSync(join(dir, 'queries.csv'), 'utf8'))
  return { store: new EvalStore(dir), rows, judgeConfig, note }
}

const progress = (note: (m: string) => void, what: string) => (done: number, total: number) => {
  if (done === total || done % 10 === 0) note(`${what}: ${done}/${total}`)
}

/**
 * Runs the queries through the API (stored as run `label`), adds the seed
 * runs if they're missing (or `refreshSeeds`), then judges whatever the pool
 * now contains that isn't judged yet.
 */
export async function runCommand(ctx: Context, options: {
  label: string
  api: Retriever
  seeds: { keywordAny: Retriever; semantic: Retriever }
  loadResources: LoadResources
  judge: JudgeFn | null
  topK?: number
  refreshSeeds?: boolean
  overwrite?: boolean
}): Promise<void> {
  const { store, rows, note } = ctx
  if (store.hasRun(options.label) && !options.overwrite) {
    throw new Error(`A run named "${options.label}" exists already. Pick another --label, or pass --force to replace it.`)
  }
  const run = await runQueries({
    label: options.label, rows, retriever: options.api, loadResources: options.loadResources, topK: options.topK,
    onProgress: progress(note, `${options.label}: queries`),
  })
  store.writeRun(run)

  for (const [label, retriever] of [
    [SEED_RUNS.keywordAny, options.seeds.keywordAny],
    [SEED_RUNS.semantic, options.seeds.semantic],
  ] as const) {
    if (store.hasRun(label) && !options.refreshSeeds) continue
    store.writeRun(await runQueries({
      label, rows, retriever, loadResources: options.loadResources, topK: options.topK,
      onProgress: progress(note, `${label}: queries`),
    }))
  }

  if (options.judge) await judgeCommand(ctx, { judge: options.judge, loadResources: options.loadResources })
  else note('Not judging (--no-judge): the report counts unjudged results as not relevant.')
}

export async function judgeCommand(ctx: Context, options: {
  judge: JudgeFn
  loadResources: LoadResources
  concurrency?: number
  retryDelayMs?: number
}): Promise<{ judged: number; failed: number }> {
  const { store, rows, judgeConfig, note } = ctx
  const pairs = pendingPairs(rows, store.runs(), store, judgeConfig)
  if (pairs.length === 0) {
    note(`Nothing to judge: every pooled result has a grade from ${judgeConfig.model} (prompt ${judgeConfig.promptVersion}) or a human.`)
    return { judged: 0, failed: 0 }
  }
  note(`Judging ${pairs.length} new (query, resource) pairs with ${judgeConfig.model}, prompt ${judgeConfig.promptVersion}.`)
  const result = await judgePairs({
    pairs, store, config: judgeConfig, judge: options.judge, loadResources: options.loadResources,
    concurrency: options.concurrency, retryDelayMs: options.retryDelayMs, onProgress: progress(note, 'judged'),
  })
  for (const f of result.failed) note(`Could not judge "${f.intent}" × ${f.resource}: ${f.error}`)
  return { judged: result.judged, failed: result.failed.length }
}

export function reportCommand(ctx: Context, options: { runs?: string[]; focus?: string } = {}): string {
  const { store, rows, judgeConfig } = ctx
  let runs = store.runs()
  if (options.runs?.length) {
    const missing = options.runs.filter(label => !runs.some(r => r.label === label))
    if (missing.length) throw new Error(`No such run: ${missing.join(', ')}`)
    runs = options.runs.map(label => runs.find(r => r.label === label)!)
  }
  if (runs.length === 0) throw new Error('No runs yet: start with the "run" command.')
  const report = computeReport(rows, runs, store.grades(judgeConfig))
  return renderReport(report, { judge: `${judgeConfig.model}, prompt ${judgeConfig.promptVersion}`, focus: options.focus })
}

export async function calibrateSampleCommand(ctx: Context, options: {
  n?: number
  seed?: number
  loadResources: LoadResources
}): Promise<string> {
  const { store, rows, judgeConfig, note } = ctx
  const sample = calibrationSample({ rows, runs: store.runs(), grades: store.grades(judgeConfig), n: options.n ?? 60, seed: options.seed })
  if (sample.length === 0) throw new Error('Nothing judged yet: run the "run" or "judge" command first.')
  note(`Sampled ${sample.length} judged pairs, spread over the judge's grades. Fill in your_grade (0–3) without looking up the judge's grade.`)
  return calibrationCsv(sample, await options.loadResources(sample.map(p => p.id)))
}

/**
 * Scores a filled-in calibration file against each model in `models` (the
 * active judge first). Models that haven't graded the sample's pairs yet get
 * to grade them first, which is how two judge models can be compared on the
 * same human labels.
 */
export async function calibrateScoreCommand(ctx: Context, options: {
  csvText: string
  models: Array<{ config: JudgeConfig; judge: JudgeFn | null }>
  loadResources: LoadResources
  saveOverrides?: boolean
  retryDelayMs?: number
}): Promise<string> {
  const { store, rows, note } = ctx
  const labels = readCalibrationCsv(options.csvText)
  if (labels.length === 0) throw new Error('No your_grade values in the calibration file.')
  const byResource = new Map<string, string>() // resource key → id, to judge with other models
  for (const run of store.runs()) for (const row of run.rows) for (const r of row.results) byResource.set(r.key, r.id)

  for (const { config, judge } of options.models) {
    const judged = store.judgedBy(config)
    const pairs = labels
      .filter(l => !judged(l.intent, l.resource) && byResource.has(l.resource))
      .map(l => ({ intent: l.intent, resource: l.resource, id: byResource.get(l.resource)! }))
    if (pairs.length === 0) continue
    if (!judge) { note(`${config.model} hasn't graded ${pairs.length} of the labelled pairs; they're left out of its score.`); continue }
    note(`${config.model}: grading ${pairs.length} labelled pairs it hasn't seen.`)
    await judgePairs({ pairs, store, config, judge, loadResources: options.loadResources, retryDelayMs: options.retryDelayMs })
  }

  if (options.saveOverrides) {
    const existing = new Set(store.overrides().map(o => `${o.intent}\u0000${o.resource}`))
    const fresh = labels.filter(l => !existing.has(`${l.intent}\u0000${l.resource}`))
    store.appendOverrides(fresh.map(l => ({ intent: l.intent, resource: l.resource, grade: l.grade, note: l.note || 'calibration' })))
    note(`Saved ${fresh.length} human grades to overrides.csv (they now win over the judge).`)
  }

  const entries = Object.fromEntries(options.models.map(m => [m.config.model, store.judgeEntries(m.config)]))
  return renderCalibration(scoreCalibration(labels, entries, kindLookup(rows)), labels.length)
}

/** One API to compare, e.g. the previous search on :3001 and this one on :3000. */
export interface ComparedApi {
  label: string
  fetchPath: (pathAndQuery: string) => Promise<Response>
}

/**
 * The top results of each API for the same queries, side by side: a quick
 * manual look at what a change does (docs/search.md, "Manual before/after
 * check"). Needs no database and no judge. `rows`: the queries to compare
 * (one from the command line, or all of queries.csv).
 */
export async function compareCommand(options: { apis: ComparedApi[]; rows: Array<Pick<QueryRow, 'query' | 'filters'>>; limit?: number }): Promise<string> {
  const limit = options.limit ?? 5
  const out: string[] = []
  for (const row of options.rows) {
    out.push(`## ${row.query}${row.filters ? `  [${row.filters}]` : ''}`, '')
    for (const api of options.apis) {
      const params = new URLSearchParams({ q: row.query, limit: String(limit) })
      const res = await api.fetchPath(`/api/v1/resources/search?${params}${row.filters ? `&${row.filters}` : ''}`)
      if (res.status !== 200) {
        out.push(`${api.label}: status ${res.status}`, '')
        continue
      }
      const body = await res.json() as {
        data: Array<{ title: string; provider: string; rating: number | null; num_ratings: number | null }>
        vector_search: boolean
        corrected_query?: string | null
      }
      const notes = [
        body.vector_search ? 'hybrid' : 'keywords only',
        ...(body.corrected_query ? [`corrected to "${body.corrected_query}"`] : []),
      ]
      out.push(`${api.label} (${notes.join(', ')}):`)
      if (body.data.length === 0) out.push('  (no results)')
      body.data.forEach((r, i) => {
        const rating = r.rating === null ? 'no rating' : `${r.rating} from ${r.num_ratings ?? 0} ratings`
        out.push(`  ${i + 1}. ${r.title}  [${r.provider}, ${rating}]`)
      })
      out.push('')
    }
  }
  return out.join('\n')
}
