/**
 * Files the evaluation keeps (all small, meant to be committed):
 *
 *   runs/<label>.json   what one ranker returned for every query (ids and the
 *                       fields needed to check filters), with timings
 *   judgments.jsonl     one line per (query, resource, judge model, prompt version),
 *                       appended as they're made, never rewritten
 *   overrides.csv       human grades; they win over any judge
 *
 * Runs keep raw results only. Metrics are always recomputed from the current
 * judgments and pool, so runs made at different times stay comparable.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCsvObjects, toCsv } from './csv.js'
import type { JudgeConfig } from './judge.js'
import type { Grade } from './metrics.js'

/** A resource as stored in a run. `key` is `provider:external_id`, stable across database copies. */
export interface StoredResult {
  id: string
  key: string
  title: string
  provider: string
  level: string | null
  language: string | null
  resource_type: string
  is_free: boolean | null
  has_certificate: boolean | null
  /** Semantic reference run only: the cosine distance from the query (for calibrating the distance floor). */
  distance?: number
}

export interface RunRow {
  key: string
  /** HTTP status (API runs), or 200. */
  status: number
  results: StoredResult[]
  /** Time of the first request and of a repeat of it (warm caches). null when not measured. */
  first_ms: number | null
  repeat_ms: number | null
  /** Whether the repeat returned the same ids in the same order. null when not repeated. */
  stable: boolean | null
  vector_search: boolean | null
  /** The query as the API corrected it (typos), or null. */
  corrected_query?: string | null
}

export interface Run {
  label: string
  created_at: string
  /** What produced it, e.g. "api http://localhost:3000" or "seed: keyword any-word". */
  source: string
  top_k: number
  rows: RunRow[]
}

export interface Judgment {
  /** The text judged against (the query, or for a typo the query it stands for). */
  intent: string
  resource: string
  id: string
  title: string
  grade: Grade
  reason: string
  model: string
  prompt_version: string
  judged_at: string
}

export interface Override {
  intent: string
  resource: string
  grade: Grade
  note: string
}

const OVERRIDES_HEADER = ['query', 'resource', 'grade', 'note']

const pairKey = (intent: string, resource: string) => `${intent}\u0000${resource}`

export class EvalStore {
  constructor(readonly dir: string) {}

  get runsDir() { return join(this.dir, 'runs') }
  get judgmentsPath() { return join(this.dir, 'judgments.jsonl') }
  get overridesPath() { return join(this.dir, 'overrides.csv') }

  private runPath(label: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error(`Run label "${label}": use letters, digits, ".", "_" and "-" only`)
    return join(this.runsDir, `${label}.json`)
  }

  hasRun(label: string): boolean {
    return existsSync(this.runPath(label))
  }

  writeRun(run: Run): void {
    mkdirSync(this.runsDir, { recursive: true })
    writeFileSync(this.runPath(run.label), JSON.stringify(run, null, 1) + '\n')
  }

  /** All runs, oldest first. */
  runs(): Run[] {
    if (!existsSync(this.runsDir)) return []
    return readdirSync(this.runsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(this.runsDir, f), 'utf8')) as Run)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.label.localeCompare(b.label))
  }

  judgments(): Judgment[] {
    if (!existsSync(this.judgmentsPath)) return []
    return readFileSync(this.judgmentsPath, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as Judgment)
  }

  appendJudgment(j: Judgment): void {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.judgmentsPath, JSON.stringify(j) + '\n')
  }

  overrides(): Override[] {
    if (!existsSync(this.overridesPath)) return []
    return parseCsvObjects(readFileSync(this.overridesPath, 'utf8')).map((r, i) => {
      const grade = Number(r['grade'])
      if (![0, 1, 2, 3].includes(grade) || r['grade']?.trim() === '') {
        throw new Error(`overrides.csv line ${i + 2}: grade must be 0, 1, 2 or 3`)
      }
      return { intent: (r['query'] ?? '').trim(), resource: (r['resource'] ?? '').trim(), grade: grade as Grade, note: r['note'] ?? '' }
    })
  }

  appendOverrides(list: Override[]): void {
    if (list.length === 0) return
    const fresh = !existsSync(this.overridesPath)
    const rows = list.map(o => [o.intent, o.resource, o.grade, o.note])
    appendFileSync(this.overridesPath, toCsv(fresh ? [OVERRIDES_HEADER, ...rows] : rows))
  }

  /**
   * The grade of every judged pair for one judge configuration, with human
   * overrides on top. `grade(intent, resource)` is undefined when unjudged.
   */
  grades(config: JudgeConfig): Grades {
    const map = new Map<string, { grade: Grade; reason: string; source: 'judge' | 'human' }>()
    for (const j of this.judgments()) {
      if (j.model === config.model && j.prompt_version === config.promptVersion) {
        map.set(pairKey(j.intent, j.resource), { grade: j.grade, reason: j.reason, source: 'judge' })
      }
    }
    for (const o of this.overrides()) map.set(pairKey(o.intent, o.resource), { grade: o.grade, reason: o.note, source: 'human' })
    return {
      grade: (intent, resource) => map.get(pairKey(intent, resource))?.grade,
      entry: (intent, resource) => map.get(pairKey(intent, resource)),
    }
  }

  /** This judge configuration's own judgments (no human overrides), by pair. */
  judgeEntries(config: JudgeConfig): (intent: string, resource: string) => { grade: Grade; reason: string } | undefined {
    const map = new Map<string, { grade: Grade; reason: string }>()
    for (const j of this.judgments()) {
      if (j.model === config.model && j.prompt_version === config.promptVersion) map.set(pairKey(j.intent, j.resource), j)
    }
    return (intent, resource) => map.get(pairKey(intent, resource))
  }

  /** Whether this judge configuration already graded the pair (overrides not considered). */
  judgedBy(config: JudgeConfig): (intent: string, resource: string) => boolean {
    const seen = new Set(
      this.judgments()
        .filter(j => j.model === config.model && j.prompt_version === config.promptVersion)
        .map(j => pairKey(j.intent, j.resource)),
    )
    return (intent, resource) => seen.has(pairKey(intent, resource))
  }
}

export interface Grades {
  grade(intent: string, resource: string): Grade | undefined
  entry(intent: string, resource: string): { grade: Grade; reason: string; source: 'judge' | 'human' } | undefined
}
