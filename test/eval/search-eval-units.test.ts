/** eval/search: CSV, the query file, metrics and the judge prompt (pure code, no database). */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCsv, parseCsvObjects, toCsv } from '../../eval/search/csv.js'
import { agreement, dcg, judgedAt, mean, ndcg, overlapAt, percentile, precisionAt } from '../../eval/search/metrics.js'
import { intentOf, parseFilters, parseQueries, satisfiesFilters } from '../../eval/search/queries.js'
import { buildJudgePrompt, parseJudgeReply, parseJudgeSpec, type JudgeResource } from '../../eval/search/judge.js'

describe('csv', () => {
  it('round-trips quotes, commas and line breaks', () => {
    const rows = [['a', 'b,c', 'say "hi"'], ['line\nbreak', '', 'x']]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })

  it('reads CRLF files, skips blank lines and fills missing trailing fields', () => {
    expect(parseCsvObjects('q,kind,notes\r\npython,skill\r\n\r\n')).toEqual([{ q: 'python', kind: 'skill', notes: '' }])
  })

  it('refuses an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow('unterminated')
  })
})

describe('queries.csv', () => {
  const header = 'query,kind,filters,expect,notes\n'

  it('parses the real golden query file', () => {
    const rows = parseQueries(readFileSync(new URL('../../eval/search/queries.csv', import.meta.url), 'utf8'))
    expect(rows.length).toBeGreaterThanOrEqual(40)
    const pyhton = rows.find(r => r.query === 'pyhton')!
    expect(pyhton.expect).toEqual({ type: 'same_as', query: 'python' })
    expect(intentOf(pyhton)).toBe('python')
    const filtered = rows.find(r => r.key === 'sql [level=beginner&provider=edx]')!
    expect(parseFilters(filtered.filters)).toEqual({ level: ['beginner'], provider: ['edx'], language: [], resource_type: [] })
    expect(rows.filter(r => r.expect.type === 'none').every(r => intentOf(r) === null)).toBe(true)
  })

  it.each([
    ['a duplicate row', 'python,a,,,\npython,b,,,\n', 'duplicate row "python"'],
    ['an unknown filter', 'python,a,levle=beginner,,\n', 'line 2: Unknown filter "levle"'],
    ['a non-boolean is_free', 'python,a,is_free=yes,,\n', 'is_free must be true or false'],
    ['an unknown expect', 'python,a,,maybe,\n', 'Unknown expect value'],
    ['same_as without a target row', 'pyhton,typo,,same_as:python,\n', 'which has no unfiltered row'],
    ['an empty query', ',a,,,\n', 'line 2: empty query'],
  ])('refuses %s', (_label, body, message) => {
    expect(() => parseQueries(header + body)).toThrow(message)
  })

  it('checks filters with the API semantics (any listed value; NULL never matches)', () => {
    const r = { level: 'beginner', provider: 'edx', language: null, resource_type: 'course', is_free: null, has_certificate: true }
    expect(satisfiesFilters(r, parseFilters('level=beginner&level=advanced&provider=edx'))).toBe(true)
    expect(satisfiesFilters(r, parseFilters('language=en'))).toBe(false)
    expect(satisfiesFilters(r, parseFilters('is_free=false'))).toBe(false)
    expect(satisfiesFilters(r, parseFilters('has_certificate=true'))).toBe(true)
  })
})

describe('metrics', () => {
  it('dcg uses exponential gain and a log2 discount', () => {
    expect(dcg([3, 2, 0], 10)).toBeCloseTo(7 + 3 / Math.log2(3), 10)
    expect(dcg([3, 2, 1], 1)).toBe(7)
  })

  it('ndcg compares with the best ordering of the whole judged pool', () => {
    expect(ndcg([3, 2, 1], [1, 3, 2])).toBe(1)
    const ideal = 7 + 3 / Math.log2(3) + 1 / 2
    expect(ndcg([3, 2], [3, 2, 1])).toBeCloseTo((7 + 3 / Math.log2(3)) / ideal, 10)
    expect(ndcg([undefined, 3], [3])).toBeCloseTo(1 / Math.log2(3), 10) // unjudged counts as 0
    expect(ndcg([], [3])).toBe(0) // no results
    expect(ndcg([0, 0], [0, 0])).toBeNull() // nothing relevant to find
  })

  it('precision, judged share and overlap', () => {
    expect(precisionAt([3, 2, 1, undefined], 10)).toBe(0.2)
    expect(precisionAt([3, 3], 2)).toBe(1)
    expect(judgedAt([3, undefined])).toBe(0.5)
    expect(judgedAt([])).toBeNull()
    expect(overlapAt(['a', 'b', 'c'], ['b', 'x'])).toBe(0.5)
    expect(overlapAt(['a'], [])).toBeNull()
  })

  it('mean and percentiles ignore missing values', () => {
    expect(mean([1, null, 3])).toBe(2)
    expect(mean([null])).toBeNull()
    const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5]
    expect([percentile(values, 50), percentile(values, 95), percentile(values, 0)]).toEqual([5, 10, 1])
    expect(percentile([], 50)).toBeNull()
  })

  it('agreement: exact, within one, relevant side, and weighted kappa', () => {
    const perfect = agreement([[0, 0], [1, 1], [2, 2], [3, 3]])
    expect(perfect).toEqual({ n: 4, exact: 1, within1: 1, relevant: 1, kappa: 1 })
    const offByOne = agreement([[0, 1], [1, 2], [2, 3], [3, 3]])
    expect([offByOne.exact, offByOne.within1, offByOne.relevant]).toEqual([0.25, 1, 0.75])
    expect(offByOne.kappa!).toBeGreaterThan(0.5)
    expect(agreement([[0, 3], [3, 0], [0, 3], [3, 0]]).kappa!).toBeLessThan(0) // worse than chance
    expect(agreement([[2, 2], [2, 2]]).kappa).toBeNull() // one grade only: undefined
    expect(agreement([]).n).toBe(0)
  })
})

describe('judge prompt', () => {
  const resource: JudgeResource = {
    title: 'Python for Data Analysis', provider: 'udemy', provider_type: null, resource_type: 'course',
    institution: null, level: 'all_levels', duration_hours: 12.25, skills: ['Python', 'pandas'],
    ai_summary: 'Use pandas to analyse data.',
  }

  it('shows what a learner would see, and the rubric', () => {
    const prompt = buildJudgePrompt('python data "analysis"', resource)
    expect(prompt).toContain('A learner searched for: "python data \\"analysis\\""')
    for (const text of ['Title: Python for Data Analysis', 'Offered by: udemy', 'Type: course', 'Level: all levels',
      'Duration: about 12.3 hours', 'Skills: Python, pandas', 'Summary: Use pandas to analyse data.', '3 = Highly relevant']) {
      expect(prompt).toContain(text)
    }
  })

  it('leaves out missing fields and never mentions ratings', () => {
    const prompt = buildJudgePrompt('x', { ...resource, level: null, duration_hours: null, skills: [], ai_summary: null })
    expect(prompt).not.toMatch(/Level:|Duration:|Skills:|Summary:/)
    expect(prompt).not.toMatch(/\d(\.\d)? stars|num_ratings|rating:/i)
  })

  it('reads a judge spec: a model, optionally with a thinking budget', () => {
    expect(parseJudgeSpec('gemini-2.5-flash')).toEqual({ model: 'gemini-2.5-flash' })
    expect(parseJudgeSpec('gemini-2.5-flash@thinking=0')).toEqual({ model: 'gemini-2.5-flash', thinkingBudget: 0 })
    for (const bad of ['', 'gemini flash', 'gemini-2.5-pro@thinking=', 'gemini-2.5-pro@thinking=-1']) {
      expect(() => parseJudgeSpec(bad)).toThrow('Invalid judge')
    }
  })

  it('parses the reply: grade as a number or a digit string', () => {
    expect(parseJudgeReply('{"reason":"About pandas.","grade":"3"}')).toEqual({ grade: 3, reason: 'About pandas.' })
    expect(parseJudgeReply('{"grade":0}')).toEqual({ grade: 0, reason: '' })
    for (const bad of ['{"grade":4}', '{"grade":"x"}', '{}', 'not json']) expect(() => parseJudgeReply(bad)).toThrow()
  })
})
