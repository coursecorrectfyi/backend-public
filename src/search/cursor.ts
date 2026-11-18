/**
 * Search cursors (version 2): where the previous page ended, and how it was ranked.
 *
 *   { v: 2, sort, mode, values, id }   → JSON → base64url
 *
 * - `mode` ('hybrid' or 'keyword') is how page 1 was ranked. A cursor always
 *   continues in its own mode, so a page is never ranked differently from
 *   the one before it (search.ts).
 * - `values` + `id` are the last row's position in the sort (ordering.ts).
 *
 * Everything in a cursor comes from the client, so it's validated completely:
 * a made-up or outdated cursor is refused (400) rather than paging through
 * the wrong order. Cursors from before version 2 are refused the same way;
 * the frontend then offers to reload the results.
 */
import { isUuid } from '../lib/ids.js'
import { SORTS, type Position, type SortKey, type SortValue } from './ordering.js'

export const RANKING_MODES = ['hybrid', 'keyword'] as const
export type RankingMode = typeof RANKING_MODES[number]

export interface Cursor extends Position {
  v: 2
  sort: SortKey
  mode: RankingMode
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

/** ISO 8601 UTC with exactly six fractional digits, as the search produces them. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

function validValue(value: unknown, kind: 'number' | 'integer' | 'timestamp', nullable: boolean): value is SortValue {
  if (value === null) return nullable
  switch (kind) {
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'timestamp': return typeof value === 'string' && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
  }
}

/** Decodes and fully validates a cursor for `sort`, or returns null. */
export function parseCursor(token: string, sort: SortKey, maxChars: number): Cursor | null {
  if (token.length > maxChars) return null
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(token, 'base64url').toString())
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const c = raw as Record<string, unknown>
  if (c['v'] !== 2 || c['sort'] !== sort) return null // a cursor only continues the sort it was made for
  if (!RANKING_MODES.includes(c['mode'] as RankingMode)) return null
  if (typeof c['id'] !== 'string' || !isUuid(c['id'])) return null
  const parts = SORTS[sort]
  const values = c['values']
  if (!Array.isArray(values) || values.length !== parts.length) return null
  if (!values.every((v, i) => validValue(v, parts[i]!.kind, parts[i]!.nullable))) return null
  return { v: 2, sort, mode: c['mode'] as RankingMode, values: values as SortValue[], id: c['id'].toLowerCase() }
}
