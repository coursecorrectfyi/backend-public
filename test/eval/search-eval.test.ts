/**
 * eval/search end to end: the commands against the in-process API and PGlite
 * (the golden test catalogue), with a fake judge.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApp } from '../helpers/app.js'
import { db, resetDb } from '../fakes/db.js'
import { embedQuery } from '../fakes/embedding.js'
import { conceptEmbedding, conceptsOf, insertCatalogue } from '../helpers/search-catalogue.js'
import {
  calibrateSampleCommand, calibrateScoreCommand, compareCommand, judgeCommand, loadContext, reportCommand, runCommand,
  type Context,
} from '../../eval/search/commands.js'
import { PROMPT_VERSION, type JudgeFn } from '../../eval/search/judge.js'
import { apiRetriever, keywordAnyRetriever, loadResources, semanticRetriever } from '../../eval/search/retrievers.js'
import { computeReport } from '../../eval/search/report.js'
import { parseCsvObjects, toCsv } from '../../eval/search/csv.js'

const QUERIES = `query,kind,filters,expect,notes
python,single_skill,,,
how to make a website,natural_language,,,
pyhton,typo,,same_as:python,
python,filtered,provider=coursera,,
blockchain,single_skill,,,nothing in the test catalogue, and no close word
qwxzv blorp,nonsense,,none,
`

/**
 * A deterministic stand-in for the LLM judge: 3 when the resource covers all
 * of the query's concepts, 1 when some, 0 when none (concepts as in the fake
 * embedding).
 */
const fakeJudge = vi.fn<JudgeFn>(async (query, r) => {
  const wanted = conceptsOf(query)
  const has = new Set(conceptsOf([r.title, r.ai_summary, ...(r.skills ?? [])].join(' ')))
  const shared = wanted.filter(c => has.has(c)).length
  const grade = wanted.length === 0 || shared === 0 ? 0 : shared === wanted.length ? 3 : 1
  return { grade, reason: `${shared} of ${wanted.length} concepts` }
})

let dir: string
let ctx: Context
let notes: string[]

beforeEach(async () => {
  await resetDb()
  embedQuery.mockImplementation(async (text: string) => conceptEmbedding(text))
  fakeJudge.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'search-eval-'))
  writeFileSync(join(dir, 'queries.csv'), QUERIES)
  notes = []
  ctx = loadContext(dir, { model: 'fake-judge', promptVersion: PROMPT_VERSION }, m => notes.push(m))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run(label = 'baseline', extra: Partial<Parameters<typeof runCommand>[1]> = {}) {
  const app = await loadApp()
  await runCommand(ctx, {
    label,
    api: apiRetriever(path => app.get(path), 'in-process'),
    seeds: { keywordAny: keywordAnyRetriever(db), semantic: semanticRetriever(db, embedQuery) },
    loadResources: ids => loadResources(db, ids),
    judge: fakeJudge,
    ...extra,
  })
}

const report = () => computeReport(ctx.rows, ctx.store.runs(), ctx.store.grades(ctx.judgeConfig))
const rowOf = (label: string, key: string) => {
  const r = report().runs.find(x => x.summary.label === label)!
  return r.rows.find(m => m.key === key)!
}

describe('search eval: run, judge, report', () => {
  it('runs the API and the two reference rankers, and judges the whole pool once', async () => {
    await insertCatalogue()
    await run()
    expect(ctx.store.runs().map(r => r.label).sort()).toEqual(['baseline', 'seed-keyword-any', 'seed-semantic'])

    const judgments = ctx.store.judgments()
    expect(judgments.length).toBeGreaterThan(0)
    expect(judgments.every(j => j.model === 'fake-judge' && j.prompt_version === PROMPT_VERSION)).toBe(true)
    expect(judgments.some(j => j.intent === 'pyhton')).toBe(false) // typo results are judged against "python"
    expect(judgments.some(j => j.intent === 'qwxzv blorp')).toBe(false) // nonsense isn't judged

    // Each pair is judged once; a second pass has nothing to do.
    const calls = fakeJudge.mock.calls.length
    expect(calls).toBe(new Set(judgments.map(j => `${j.intent}|${j.resource}`)).size)
    expect(await judgeCommand(ctx, { judge: fakeJudge, loadResources: ids => loadResources(db, ids) })).toEqual({ judged: 0, failed: 0 })
    expect(fakeJudge).toHaveBeenCalledTimes(calls)
  })

  it('measures relevance, zero results, typos, filters and nonsense for every source', async () => {
    await insertCatalogue()
    await run()

    // Relevance: the fake judge grades by concepts, so the semantic reference ranker is near perfect here.
    expect(rowOf('seed-semantic', 'how to make a website').ndcg!).toBeGreaterThan(0.8)
    expect(rowOf('baseline', 'python').ndcg!).toBeGreaterThan(0.8)
    // A query the catalogue can't answer: no results, and nothing relevant to rank (nDCG left out).
    expect(rowOf('baseline', 'blockchain')).toMatchObject({ results: 0, ndcg: null })
    // Typos are judged against the intended query and compared with its results.
    expect(rowOf('baseline', 'pyhton').overlap).toEqual(expect.any(Number))
    // Filters are respected by every source.
    for (const label of ['baseline', 'seed-keyword-any', 'seed-semantic']) expect(rowOf(label, 'python [provider=coursera]').offFilter).toBe(0)
    // Nonsense: the API has a similarity floor; the semantic reference ranker doesn't, and returns its nearest neighbours.
    expect(rowOf('baseline', 'qwxzv blorp').nonsenseOk).toBe(true)
    expect(rowOf('seed-semantic', 'qwxzv blorp').nonsenseOk).toBe(false)

    // Distances: relevant results are nearer than irrelevant ones (what the floor is calibrated on).
    const distances = Object.fromEntries(report().distances.map(d => [d.grade, d]))
    expect(distances[3]!.p50!).toBeLessThan(distances[0]!.p50!)

    const baseline = report().runs.find(r => r.summary.label === 'baseline')!.summary
    expect(baseline).toMatchObject({ answerable: 5, nonsenseOk: 1, nonsense: 1, offFilter: 0, unjudgedInTop10: 0, unstable: 0, errors: 0 })
    expect(baseline.zeroResults).toBeGreaterThanOrEqual(1) // blockchain
    expect(baseline.firstP50).toEqual(expect.any(Number))
  })

  it('renders a Markdown report with the summary, every query and the weakest queries', async () => {
    await insertCatalogue()
    await run()
    const md = reportCommand(ctx, { focus: 'baseline' })
    expect(md).toContain('| nDCG@10, mean | ')
    expect(md).toContain('| blockchain | – (0), **no results** |')
    expect(md).toContain('| qwxzv blorp | ✓ none |')
    expect(md).toContain('## Weakest queries in baseline')
    expect(md).toMatch(/\| pyhton \| [^|]*as "python"/) // the API's typo correction
    // Distances of the semantic reference run, by grade, for calibrating the distance floor.
    expect(md).toContain('## Semantic distance by grade')
    expect(md).toMatch(/\| 3 \| \d+ \| 0\.\d{3} \|/)
    expect(reportCommand(ctx, { runs: ['seed-semantic'] })).toContain('✗ ')
    expect(() => reportCommand(ctx, { runs: ['nope'] })).toThrow('No such run: nope')
  })

  it('new results from a later run join the pool and get judged; old runs are rescored against it', async () => {
    await insertCatalogue()
    await run()
    const before = ctx.store.judgments().length
    // A catalogue change: a new Python course the later run finds.
    const { insertResource } = await import('../helpers/fixtures.js')
    await insertResource({ title: 'Python Testing with pytest', skills: ['Python'], embedding: conceptEmbedding('python') })
    await run('next')
    expect(ctx.store.judgments().length).toBeGreaterThan(before)
    expect(ctx.store.judgments().some(j => j.title === 'Python Testing with pytest')).toBe(true)
  })

  it('refuses to overwrite a run unless asked', async () => {
    await insertCatalogue()
    await run()
    await expect(run()).rejects.toThrow('exists already')
    await run('baseline', { overwrite: true })
  })

  it('keeps going when the judge fails: retries, then leaves the pair for the next run', async () => {
    await insertCatalogue()
    const flaky = vi.fn<JudgeFn>(async (query, r) => {
      if (r.title === 'Python for Everybody') throw new Error('Vertex AI 503')
      if (flaky.mock.calls.length === 1) throw new Error('429 RESOURCE_EXHAUSTED')
      return fakeJudge(query, r)
    })
    const app = await loadApp()
    await runCommand(ctx, {
      label: 'baseline', api: apiRetriever(path => app.get(path), 'in-process'),
      seeds: { keywordAny: keywordAnyRetriever(db), semantic: semanticRetriever(db, embedQuery) },
      loadResources: ids => loadResources(db, ids), judge: null,
    })
    const result = await judgeCommand(ctx, { judge: flaky, loadResources: ids => loadResources(db, ids), retryDelayMs: 0 })
    // Every pair with that resource failed (how many depends on which pools it's in), and nothing else did.
    const failures = notes.filter(n => n.startsWith('Could not judge'))
    expect(result.failed).toBeGreaterThan(0)
    expect(failures).toHaveLength(result.failed)
    expect(notes).toContainEqual(expect.stringMatching(/^Could not judge "python" × coursera:\S+: Vertex AI 503$/))
    for (const f of failures) expect(f).toContain('Vertex AI 503')
    expect(ctx.store.judgments().some(j => j.title === 'Python for Everybody')).toBe(false)
    expect(await judgeCommand(ctx, { judge: fakeJudge, loadResources: ids => loadResources(db, ids) }))
      .toEqual({ judged: result.failed, failed: 0 })
  })
})

describe('search eval: compare', () => {
  it('shows the top results of each API side by side, with corrections and empty results', async () => {
    await insertCatalogue()
    const app = await loadApp()
    const apis = [
      { label: 'before', fetchPath: (path: string) => app.get(path) },
      { label: 'after', fetchPath: (path: string) => app.get(path) },
    ]
    const text = await compareCommand({
      apis,
      rows: [{ query: 'pyhton', filters: '' }, { query: 'qwxzv blorp', filters: '' }, { query: 'python', filters: 'sort=rating&provider=coursera' }],
      limit: 2,
    })
    expect(text).toContain('## pyhton\n\nbefore (hybrid, corrected to "python"):\n  1. ')
    expect(text).toContain('## qwxzv blorp\n\nbefore (hybrid):\n  (no results)')
    expect(text).toContain('## python  [sort=rating&provider=coursera]')
    // Weighted rating, Coursera only: 4.9 from 150,000 ratings before 4.8 from 200,000.
    expect(text).toMatch(/after \(hybrid\):\n {2}1\. Machine Learning Specialization {2}\[coursera, 4\.9 from 150000 ratings\]\n {2}2\. Python for Everybody/)
    expect(text.match(/^ {2}\d\. /gm)!.length).toBe(2 * 2 + 2 * 2) // at most 2 results per API and query
  })

  it('reports a failing API instead of stopping', async () => {
    const text = await compareCommand({
      apis: [{ label: 'down', fetchPath: async () => new Response('{}', { status: 503 }) }],
      rows: [{ query: 'python', filters: '' }],
    })
    expect(text).toContain('down: status 503')
  })
})

describe('search eval: calibration', () => {
  it('writes a blind, stratified sample and scores human grades against each judge model', async () => {
    await insertCatalogue()
    await run()
    const csv = await calibrateSampleCommand(ctx, { n: 8, loadResources: ids => loadResources(db, ids) })
    const sample = parseCsvObjects(csv)
    expect(sample).toHaveLength(8)
    expect(Object.keys(sample[0]!)).toEqual(['query', 'resource', 'title', 'type', 'level', 'hours', 'skills', 'summary', 'your_grade', 'note'])
    expect(csv).not.toContain('concepts') // blind: no judge grade or reason
    const grades = ctx.store.grades(ctx.judgeConfig)
    expect(new Set(sample.map(s => grades.grade(s.query!, s.resource!))).size).toBeGreaterThan(1) // not all one grade

    // The human agrees with the judge except on the first pair.
    const filled = sample.map((s, i): Record<string, string> => {
      const judge = grades.grade(s.query!, s.resource!)!
      return { ...s, your_grade: String(i === 0 ? (judge + 2) % 4 : judge) }
    })
    const columns = Object.keys(sample[0]!)
    const filledCsv = toCsv([columns, ...filled.map(r => columns.map(c => r[c]))])

    const strict = vi.fn<JudgeFn>(async () => ({ grade: 0, reason: 'strict' }))
    const md = await calibrateScoreCommand(ctx, {
      csvText: filledCsv,
      models: [
        { config: ctx.judgeConfig, judge: fakeJudge },
        { config: { model: 'strict-judge', promptVersion: PROMPT_VERSION }, judge: strict },
      ],
      loadResources: ids => loadResources(db, ids),
      saveOverrides: true,
    })
    expect(md).toContain('Human labels: 8.')
    expect(md).toMatch(/\| fake-judge \| 8 \| 88% \|/)
    expect(md).toContain('| strict-judge | 8 |')
    expect(strict).toHaveBeenCalledTimes(8) // graded the labelled pairs it hadn't seen
    expect(md).toContain('Disagreements (1):')

    // Saved as overrides: the human's grade now wins.
    expect(existsSync(ctx.store.overridesPath)).toBe(true)
    const first = filled[0]!
    expect(ctx.store.grades(ctx.judgeConfig).grade(first.query!, first.resource!)).toBe(Number(first.your_grade))
    expect(readFileSync(ctx.store.overridesPath, 'utf8').split('\n')[0]).toBe('query,resource,grade,note')
  })
})
