/**
 * The golden query file (queries.csv): one row per query, with optional
 * filters and an expectation.
 *
 *   query,kind,filters,expect,notes
 *   python,single_skill,,,
 *   pyhton,typo,,same_as:python,
 *   sql,filtered,level=beginner&provider=edx,,
 *   asdfgh qwerty,nonsense,,none,
 *
 * expect:
 *   (empty)        results are judged for relevance to the query itself
 *   same_as:<q>    judged as if the query were <q> (a typo of it), and compared with <q>'s results
 *   none           there should be no results
 */
import type { SearchFilters } from '../../src/search/filters.js'
import { parseCsvObjects } from './csv.js'

export type Expectation =
  | { type: 'judged' }
  | { type: 'same_as'; query: string }
  | { type: 'none' }

export interface QueryRow {
  /** Unique per row: the query, plus the filters if any. */
  key: string
  query: string
  kind: string
  /** Query-string form, as sent to the API (e.g. "level=beginner&provider=edx"), or ''. */
  filters: string
  expect: Expectation
  notes: string
}

export type { SearchFilters }

const LIST_FILTERS = ['level', 'provider', 'language', 'resource_type'] as const
const BOOLEAN_FILTERS = ['is_free', 'has_certificate'] as const

/** Parses a filter query string the way the API reads it. Unknown names throw (a typo would silently test nothing). */
export function parseFilters(filters: string): SearchFilters {
  const params = new URLSearchParams(filters)
  const result: SearchFilters = { level: [], provider: [], language: [], resource_type: [] }
  for (const [name, value] of params) {
    if ((LIST_FILTERS as readonly string[]).includes(name)) {
      if (value.trim()) result[name as typeof LIST_FILTERS[number]].push(value.trim())
    } else if ((BOOLEAN_FILTERS as readonly string[]).includes(name)) {
      if (value !== 'true' && value !== 'false') throw new Error(`Filter ${name} must be true or false, got "${value}"`)
      result[name as typeof BOOLEAN_FILTERS[number]] = value === 'true'
    } else {
      throw new Error(`Unknown filter "${name}"`)
    }
  }
  return result
}

export function hasFilters(f: SearchFilters): boolean {
  return LIST_FILTERS.some(n => f[n].length > 0) || f.is_free !== undefined || f.has_certificate !== undefined
}

/** Whether a resource satisfies the filters (the API's semantics: any listed value; NULL never matches). */
export function satisfiesFilters(
  r: { level: string | null; provider: string; language: string | null; resource_type: string; is_free: boolean | null; has_certificate: boolean | null },
  f: SearchFilters,
): boolean {
  const inList = (value: string | null, list: string[]) => list.length === 0 || (value !== null && list.includes(value))
  return inList(r.level, f.level) && inList(r.provider, f.provider) && inList(r.language, f.language)
    && inList(r.resource_type, f.resource_type)
    && (f.is_free === undefined || r.is_free === f.is_free)
    && (f.has_certificate === undefined || r.has_certificate === f.has_certificate)
}

function parseExpect(value: string): Expectation {
  const v = value.trim()
  if (v === '') return { type: 'judged' }
  if (v === 'none') return { type: 'none' }
  if (v.startsWith('same_as:') && v.length > 'same_as:'.length) return { type: 'same_as', query: v.slice('same_as:'.length).trim() }
  throw new Error(`Unknown expect value "${value}" (use empty, none or same_as:<query>)`)
}

export function rowKey(query: string, filters: string): string {
  return filters ? `${query} [${filters}]` : query
}

/** Parses and validates queries.csv. Throws with the line number on any problem. */
export function parseQueries(csvText: string): QueryRow[] {
  const rows = parseCsvObjects(csvText).map((r, i) => {
    const line = i + 2
    try {
      const query = (r['query'] ?? '').trim()
      if (!query) throw new Error('empty query')
      const filters = (r['filters'] ?? '').trim()
      parseFilters(filters)
      return {
        key: rowKey(query, filters), query, kind: (r['kind'] ?? '').trim() || 'unspecified', filters,
        expect: parseExpect(r['expect'] ?? ''), notes: (r['notes'] ?? '').trim(),
      }
    } catch (err) {
      throw new Error(`queries.csv line ${line}: ${(err as Error).message}`)
    }
  })
  const keys = new Set<string>()
  for (const row of rows) {
    if (keys.has(row.key)) throw new Error(`queries.csv: duplicate row "${row.key}"`)
    keys.add(row.key)
  }
  for (const row of rows) {
    if (row.expect.type === 'same_as' && !rows.some(r => r.key === (row.expect as { query: string }).query)) {
      throw new Error(`queries.csv: "${row.key}" is same_as "${row.expect.query}", which has no unfiltered row`)
    }
  }
  return rows
}

/**
 * The text results are judged against: the query itself, or the query it is a
 * typo of. null for rows that should have no results.
 */
export function intentOf(row: QueryRow): string | null {
  switch (row.expect.type) {
    case 'judged': return row.query
    case 'same_as': return row.expect.query
    case 'none': return null
  }
}
