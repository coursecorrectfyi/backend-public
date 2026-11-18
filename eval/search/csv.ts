/** Minimal CSV (RFC 4180): quoted fields, doubled quotes, CRLF or LF. Enough for the eval's small files. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === ',') {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else {
      field += ch
    }
  }
  if (quoted) throw new Error('CSV: unterminated quoted field')
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => !(r.length === 1 && r[0] === '')) // blank lines
}

/** Rows as objects keyed by the header row. Missing trailing fields are ''. */
export function parseCsvObjects(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text)
  if (!header) return []
  return rows.map(r => Object.fromEntries(header.map((name, i) => [name.trim(), r[i] ?? ''])))
}

function formatField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: unknown[][]): string {
  return rows.map(r => r.map(formatField).join(',')).join('\n') + '\n'
}
