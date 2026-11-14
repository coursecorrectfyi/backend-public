const SEVERITY = { info: 'INFO', warn: 'WARNING', error: 'ERROR' } as const

/**
 * Writes one structured JSON log line to stdout. On Cloud Run, Cloud Logging
 * parses it: `severity` sets the log level and the other fields are
 * queryable as jsonPayload.<field> (e.g. jsonPayload.event).
 */
export function log(data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') {
  process.stdout.write(JSON.stringify({ level, severity: SEVERITY[level], ts: new Date().toISOString(), ...data }) + '\n')
}
