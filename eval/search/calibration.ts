/**
 * Calibration: checking the judge against a human on a sample.
 *
 * 1. calibrationSample() picks judged pairs, stratified by the judge's grade
 *    (so the sample isn't all 0s), and calibrationCsv() writes them *blind*:
 *    without the judge's grade, so the human isn't anchored by it.
 * 2. The human fills in `your_grade` (0–3, same rubric as the judge).
 * 3. scoreCalibration() compares the human with each judge model: agreement
 *    overall and per kind of query, and the disagreements with the judge's
 *    reasons. Low agreement means fixing the rubric (a new prompt version),
 *    not labelling by hand.
 */
import { parseCsvObjects, toCsv } from './csv.js'
import { agreement, type Agreement, type Grade } from './metrics.js'
import { intentOf, type QueryRow } from './queries.js'
import { pools } from './evaluate.js'
import type { ResourceDetails } from './retrievers.js'
import type { Grades, Run } from './store.js'

export interface CalibrationPair {
  intent: string
  resource: string
  id: string
  judgeGrade: Grade
}

/** Small seeded PRNG (mulberry32), so a sample can be reproduced. */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Up to `n` judged pairs from the pool, as evenly as possible across the judge's four grades. */
export function calibrationSample(options: {
  rows: QueryRow[]
  runs: Run[]
  grades: Grades
  n: number
  seed?: number
}): CalibrationPair[] {
  const { rows, runs, grades, n } = options
  const next = random(options.seed ?? 1)
  const buckets: CalibrationPair[][] = [[], [], [], []]
  const seen = new Set<string>()
  const poolByRow = pools(rows, runs)
  for (const row of rows) {
    const intent = intentOf(row)
    if (intent === null) continue
    for (const [resource, id] of poolByRow.get(row.key)!) {
      const key = `${intent}\u0000${resource}`
      if (seen.has(key)) continue
      seen.add(key)
      const entry = grades.entry(intent, resource)
      if (entry?.source === 'judge') buckets[entry.grade]!.push({ intent, resource, id, judgeGrade: entry.grade })
    }
  }
  for (const bucket of buckets) {
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[bucket[i], bucket[j]] = [bucket[j]!, bucket[i]!]
    }
  }
  const sample: CalibrationPair[] = []
  while (sample.length < n && buckets.some(b => b.length > 0)) {
    for (const bucket of buckets) {
      const pair = bucket.pop()
      if (pair && sample.length < n) sample.push(pair)
    }
  }
  // Shuffle the final order too, so grades don't come in a visible rhythm.
  for (let i = sample.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[sample[i], sample[j]] = [sample[j]!, sample[i]!]
  }
  return sample
}

export const CALIBRATION_COLUMNS = [
  'query', 'resource', 'title', 'type', 'level', 'hours', 'skills', 'summary', 'your_grade', 'note',
] as const

/** The sample as a CSV to fill in. Blind: the judge's grade is not included. */
export function calibrationCsv(sample: CalibrationPair[], details: Map<string, ResourceDetails>): string {
  const rows = sample.flatMap(p => {
    const d = details.get(p.id)
    if (!d) return []
    const type = d.provider_type ? `${d.resource_type} (${d.provider_type})` : d.resource_type
    return [[p.intent, p.resource, d.title, type, d.level ?? '', d.duration_hours ?? '', (d.skills ?? []).join(', '), d.ai_summary ?? '', '', '']]
  })
  return toCsv([[...CALIBRATION_COLUMNS], ...rows])
}

export interface HumanLabel { intent: string; resource: string; title: string; grade: Grade; note: string }

/** The rows of a filled-in calibration CSV that have a grade. */
export function readCalibrationCsv(csvText: string): HumanLabel[] {
  return parseCsvObjects(csvText).flatMap((r, i) => {
    const raw = (r['your_grade'] ?? '').trim()
    if (raw === '') return []
    if (!/^[0-3]$/.test(raw)) throw new Error(`Calibration CSV line ${i + 2}: your_grade must be 0, 1, 2 or 3, got "${raw}"`)
    return [{ intent: r['query'] ?? '', resource: r['resource'] ?? '', title: r['title'] ?? '', grade: Number(raw) as Grade, note: r['note'] ?? '' }]
  })
}

export interface ModelAgreement {
  model: string
  /** Labels the model has a grade for (all of them, once judged). */
  overall: Agreement
  byKind: Record<string, Agreement>
  disagreements: Array<{ intent: string; title: string; human: Grade; judge: Grade; reason: string }>
}

/**
 * Compares human labels with each judge model. `judgeEntries[model]` gives
 * that model's own judgment (not human overrides) for a pair.
 */
export function scoreCalibration(
  labels: HumanLabel[],
  judgeEntries: Record<string, (intent: string, resource: string) => { grade: Grade; reason: string } | undefined>,
  kindOf: (intent: string) => string,
): ModelAgreement[] {
  return Object.entries(judgeEntries).map(([model, entryOf]) => {
    const compared = labels.flatMap(l => {
      const e = entryOf(l.intent, l.resource)
      return e ? [{ label: l, judge: e }] : []
    })
    const byKind: Record<string, Agreement> = {}
    for (const kind of [...new Set(compared.map(c => kindOf(c.label.intent)))]) {
      byKind[kind] = agreement(compared.filter(c => kindOf(c.label.intent) === kind).map(c => [c.label.grade, c.judge.grade] as const))
    }
    return {
      model,
      overall: agreement(compared.map(c => [c.label.grade, c.judge.grade] as const)),
      byKind,
      disagreements: compared
        .filter(c => c.label.grade !== c.judge.grade)
        .map(c => ({ intent: c.label.intent, title: c.label.title, human: c.label.grade, judge: c.judge.grade, reason: c.judge.reason })),
    }
  })
}

/** Kind of query for an intent: the kind of its unfiltered row. */
export function kindLookup(rows: QueryRow[]): (intent: string) => string {
  return intent => rows.find(r => r.query === intent && !r.filters)?.kind ?? rows.find(r => r.query === intent)?.kind ?? 'unspecified'
}

export function renderCalibration(results: ModelAgreement[], labelled: number): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const k = (v: number | null) => (v === null ? '–' : v.toFixed(2))
  const out = [`# Judge calibration`, '', `Human labels: ${labelled}.`, '']
  out.push('| model | compared | exact | within 1 | same side of "relevant" (≥ 2) | weighted kappa |', '|---|---|---|---|---|---|')
  for (const r of results) {
    const a = r.overall
    out.push(`| ${r.model} | ${a.n} | ${pct(a.exact)} | ${pct(a.within1)} | ${pct(a.relevant)} | ${k(a.kappa)} |`)
  }
  for (const r of results) {
    out.push('', `## ${r.model}: by kind of query`, '', '| kind | compared | exact | same side of "relevant" | weighted kappa |', '|---|---|---|---|---|')
    for (const [kind, a] of Object.entries(r.byKind)) {
      out.push(`| ${kind} | ${a.n} | ${pct(a.exact)} | ${pct(a.relevant)} | ${k(a.kappa)} |`)
    }
    out.push('', `Disagreements (${r.disagreements.length}):`, '')
    for (const d of r.disagreements) {
      out.push(`- "${d.intent}" → ${d.title}: you ${d.human}, judge ${d.judge}. Judge's reason: ${d.reason}`)
    }
  }
  return out.join('\n') + '\n'
}
