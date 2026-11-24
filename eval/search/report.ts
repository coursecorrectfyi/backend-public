/** Metrics per run and query, and the Markdown report comparing runs. */
import { judgedAt, mean, ndcg, overlapAt, percentile, precisionAt } from './metrics.js'
import { hasFilters, intentOf, parseFilters, satisfiesFilters, type QueryRow } from './queries.js'
import { pools } from './evaluate.js'
import type { Grades, Run } from './store.js'

export interface RowMetrics {
  key: string
  kind: string
  ran: boolean
  status: number | null
  results: number
  /** null: not judged (nonsense row), or nothing relevant in the pool. */
  ndcg: number | null
  p10: number | null
  judged: number | null
  /** Typo rows: overlap@10 with the intended query's results in the same run. */
  overlap: number | null
  /** Results that don't satisfy the row's filters (should always be 0). */
  offFilter: number
  /** A filtered query with no results although the pool has relevant resources that satisfy the filters. */
  starved: boolean
  /** Nonsense rows: true when there are no results. */
  nonsenseOk: boolean | null
  first_ms: number | null
  repeat_ms: number | null
  stable: boolean | null
  /** Top results with their grades, for reading the report. */
  top: Array<{ title: string; grade: number | undefined }>
  /** The API's typo correction of the query, if any. */
  corrected: string | null
}

export interface RunSummary {
  label: string
  source: string
  created_at: string
  ndcg: number | null
  ndcgQueries: number
  p10: number | null
  ndcgByKind: Record<string, number | null>
  zeroResults: number
  answerable: number
  nonsenseOk: number
  nonsense: number
  typoOverlap: number | null
  offFilter: number
  starved: number
  unjudgedInTop10: number
  firstP50: number | null
  firstP95: number | null
  repeatP50: number | null
  repeatP95: number | null
  unstable: number
  errors: number
}

/** Semantic distances of judged results, per grade: where to put the distance floor (config.ts, semantic.maxDistance). */
export interface DistanceByGrade {
  grade: number
  n: number
  p10: number | null
  p50: number | null
  p90: number | null
}

export interface Report {
  rows: QueryRow[]
  runs: Array<{ summary: RunSummary; rows: RowMetrics[] }>
  judgedPairs: number
  humanPairs: number
  /** From runs that recorded distances (the semantic reference run); empty without one. */
  distances: DistanceByGrade[]
}

export function computeReport(rows: QueryRow[], runs: Run[], grades: Grades): Report {
  const poolByRow = pools(rows, runs)
  const kinds = [...new Set(rows.map(r => r.kind))]
  let judgedPairs = 0
  let humanPairs = 0
  const counted = new Set<string>()
  for (const row of rows) {
    const intent = intentOf(row)
    if (intent === null) continue
    for (const resource of poolByRow.get(row.key)!.keys()) {
      const k = `${intent}\u0000${resource}`
      if (counted.has(k)) continue
      counted.add(k)
      const entry = grades.entry(intent, resource)
      if (entry) { judgedPairs++; if (entry.source === 'human') humanPairs++ }
    }
  }

  const reportRuns = runs.map(run => {
    const byKey = new Map(run.rows.map(r => [r.key, r]))
    const metrics: RowMetrics[] = rows.map(row => {
      const runRow = byKey.get(row.key)
      const intent = intentOf(row)
      const filters = parseFilters(row.filters)
      if (!runRow) {
        return {
          key: row.key, kind: row.kind, ran: false, status: null, results: 0, ndcg: null, p10: null, judged: null,
          overlap: null, offFilter: 0, starved: false, nonsenseOk: null, first_ms: null, repeat_ms: null, stable: null, top: [],
          corrected: null,
        }
      }
      const resultGrades = intent === null ? [] : runRow.results.map(r => grades.grade(intent, r.key))
      const poolGrades = intent === null ? [] : [...poolByRow.get(row.key)!.keys()]
        .map(key => grades.grade(intent, key))
        .filter((g): g is NonNullable<typeof g> => g !== undefined)
      const target = row.expect.type === 'same_as' ? byKey.get(row.expect.query) : undefined
      const relevantInPool = poolGrades.some(g => g >= 2)
      return {
        key: row.key,
        kind: row.kind,
        ran: true,
        status: runRow.status,
        results: runRow.results.length,
        ndcg: intent === null ? null : ndcg(resultGrades, poolGrades),
        p10: intent === null || !relevantInPool ? null : precisionAt(resultGrades),
        judged: intent === null ? null : judgedAt(resultGrades),
        overlap: target ? overlapAt(runRow.results.map(r => r.id), target.results.map(r => r.id)) : null,
        offFilter: runRow.results.filter(r => !satisfiesFilters(r, filters)).length,
        starved: hasFilters(filters) && runRow.status === 200 && runRow.results.length === 0 && relevantInPool,
        nonsenseOk: row.expect.type === 'none' ? runRow.status === 200 && runRow.results.length === 0 : null,
        first_ms: runRow.first_ms,
        repeat_ms: runRow.repeat_ms,
        stable: runRow.stable,
        top: runRow.results.slice(0, 3).map((r, i) => ({ title: r.title, grade: resultGrades[i] })),
        corrected: runRow.corrected_query ?? null,
      }
    })

    const ran = metrics.filter(m => m.ran)
    const answerable = ran.filter(m => rows.find(r => r.key === m.key)!.expect.type !== 'none')
    const nonsense = ran.filter(m => m.nonsenseOk !== null)
    const summary: RunSummary = {
      label: run.label,
      source: run.source,
      created_at: run.created_at,
      ndcg: mean(ran.map(m => m.ndcg)),
      ndcgQueries: ran.filter(m => m.ndcg !== null).length,
      p10: mean(ran.map(m => m.p10)),
      ndcgByKind: Object.fromEntries(kinds.map(k => [k, mean(ran.filter(m => m.kind === k).map(m => m.ndcg))])),
      zeroResults: answerable.filter(m => m.status === 200 && m.results === 0).length,
      answerable: answerable.length,
      nonsenseOk: nonsense.filter(m => m.nonsenseOk).length,
      nonsense: nonsense.length,
      typoOverlap: mean(ran.map(m => m.overlap)),
      offFilter: ran.reduce((sum, m) => sum + m.offFilter, 0),
      starved: ran.filter(m => m.starved).length,
      unjudgedInTop10: ran.filter(m => m.judged !== null && m.judged < 1).length,
      firstP50: percentile(ran.map(m => m.first_ms), 50),
      firstP95: percentile(ran.map(m => m.first_ms), 95),
      repeatP50: percentile(ran.map(m => m.repeat_ms), 50),
      repeatP95: percentile(ran.map(m => m.repeat_ms), 95),
      unstable: ran.filter(m => m.stable === false).length,
      errors: ran.filter(m => m.status !== 200).length,
    }
    return { summary, rows: metrics }
  })

  return { rows, runs: reportRuns, judgedPairs, humanPairs, distances: distancesByGrade(rows, runs, grades) }
}

function distancesByGrade(rows: QueryRow[], runs: Run[], grades: Grades): DistanceByGrade[] {
  const byGrade = new Map<number, number[]>()
  const seen = new Set<string>()
  for (const run of runs) {
    for (const runRow of run.rows) {
      const row = rows.find(r => r.key === runRow.key)
      const intent = row ? intentOf(row) : null
      if (intent === null) continue
      for (const r of runRow.results) {
        const grade = grades.grade(intent, r.key)
        const pair = `${intent}\u0000${r.key}`
        if (r.distance === undefined || grade === undefined || seen.has(pair)) continue
        seen.add(pair)
        byGrade.set(grade, [...(byGrade.get(grade) ?? []), r.distance])
      }
    }
  }
  return [...byGrade.entries()].sort(([a], [b]) => a - b).map(([grade, d]) => ({
    grade, n: d.length, p10: percentile(d, 10), p50: percentile(d, 50), p90: percentile(d, 90),
  }))
}

const num = (v: number | null, digits = 2) => (v === null ? '–' : v.toFixed(digits))
const ms = (v: number | null) => (v === null ? '–' : String(Math.round(v)))
// Markdown table cell: escape backslashes first, then the pipes that would end the cell.
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

function cell(m: RowMetrics): string {
  if (!m.ran) return 'not run'
  if (m.status !== 200) return `status ${m.status}`
  if (m.nonsenseOk !== null) return m.nonsenseOk ? '✓ none' : `✗ ${m.results} results`
  const parts = [`${num(m.ndcg)} (${m.results})`]
  if (m.corrected !== null) parts.push(`as "${esc(m.corrected)}"`)
  if (m.overlap !== null) parts.push(`overlap ${num(m.overlap)}`)
  if (m.results === 0) parts.push('**no results**')
  if (m.starved) parts.push('**starved**')
  if (m.offFilter) parts.push(`**${m.offFilter} off-filter**`)
  if (m.judged !== null && m.judged < 1) parts.push(`${Math.round(m.judged * 100)}% judged`)
  if (m.stable === false) parts.push('unstable')
  return parts.join(', ')
}

/**
 * Markdown: a summary per run, nDCG by query kind, every query, and the
 * weakest queries of `focus` (default: the newest run) with their top results.
 */
export function renderReport(report: Report, options: { judge: string; focus?: string } = { judge: '' }): string {
  const { runs } = report
  const header = (first: string) =>
    `| ${first} | ${runs.map(r => esc(r.summary.label)).join(' | ')} |\n|---|${runs.map(() => '---').join('|')}|`
  const line = (label: string, f: (s: RunSummary) => string) =>
    `| ${label} | ${runs.map(r => f(r.summary)).join(' | ')} |`

  const out: string[] = []
  out.push('# Search evaluation', '')
  out.push(`Judge: ${options.judge}. Judged pairs in the pool: ${report.judgedPairs} (${report.humanPairs} by a human). Queries: ${report.rows.length}.`, '')
  out.push('Runs:', '', ...runs.map(r => `- **${esc(r.summary.label)}** (${r.summary.created_at.slice(0, 16).replace('T', ' ')}): ${esc(r.summary.source)}`), '')
  out.push('## Summary', '', header(''))
  out.push(line('nDCG@10, mean', s => `${num(s.ndcg)} (${s.ndcgQueries} queries)`))
  out.push(line('P@10, grade ≥ 2', s => num(s.p10)))
  out.push(line('Queries without results (excl. nonsense)', s => `${s.zeroResults} / ${s.answerable}`))
  out.push(line('Nonsense without results', s => `${s.nonsenseOk} / ${s.nonsense}`))
  out.push(line('Typos: overlap@10 with the intended query', s => num(s.typoOverlap)))
  out.push(line('Results outside the filters', s => String(s.offFilter)))
  out.push(line('Filtered queries starved', s => String(s.starved)))
  out.push(line('Queries with unjudged top-10 results', s => String(s.unjudgedInTop10)))
  out.push(line('First request p50 / p95 ms', s => `${ms(s.firstP50)} / ${ms(s.firstP95)}`))
  out.push(line('Repeat request p50 / p95 ms', s => `${ms(s.repeatP50)} / ${ms(s.repeatP95)}`))
  out.push(line('Unstable (repeat differs)', s => String(s.unstable)))
  out.push(line('Errors (not 200)', s => String(s.errors)))
  out.push('')

  const kinds = [...new Set(report.rows.map(r => r.kind))]
  out.push('## nDCG@10 by kind of query', '', header('kind'))
  for (const kind of kinds) out.push(line(esc(kind), s => num(s.ndcgByKind[kind] ?? null)))
  out.push('')

  out.push('## Every query', '', 'nDCG@10 (number of results), and anything to look at.', '', header('query'))
  report.rows.forEach((row, i) => {
    out.push(`| ${esc(row.key)} | ${runs.map(r => cell(r.rows[i]!)).join(' | ')} |`)
  })
  out.push('')

  if (report.distances.length > 0) {
    out.push('## Semantic distance by grade', '')
    out.push('Cosine distances of judged results from the semantic reference run, for calibrating')
    out.push('`semantic.maxDistance` in src/search/config.ts (docs/search.md, "Tuning"): the floor belongs')
    out.push('above most distances of grades 2–3 and below most of grade 0.', '')
    out.push('| grade | results | p10 | median | p90 |', '|---|---|---|---|---|')
    for (const d of report.distances) out.push(`| ${d.grade} | ${d.n} | ${num(d.p10, 3)} | ${num(d.p50, 3)} | ${num(d.p90, 3)} |`)
    out.push('')
  }

  const focus = runs.find(r => r.summary.label === options.focus) ?? runs[runs.length - 1]
  if (focus) {
    const weakest = focus.rows
      .filter(m => m.ran && m.ndcg !== null)
      .sort((a, b) => a.ndcg! - b.ndcg!)
      .slice(0, 10)
    out.push(`## Weakest queries in ${esc(focus.summary.label)}`, '')
    for (const m of weakest) {
      const top = m.top.map(t => `${esc(t.title)} (${t.grade ?? '?'})`).join('; ') || 'no results'
      out.push(`- **${esc(m.key)}**: nDCG ${num(m.ndcg)}. Top: ${top}`)
    }
    out.push('')
  }
  return out.join('\n')
}
