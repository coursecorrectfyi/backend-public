const SEVERITY = { info: 'INFO', warn: 'WARNING', error: 'ERROR' } as const

/**
 * Writes one structured JSON log line to stdout. On Cloud Run, Cloud Logging
 * parses it: `severity` sets the log level and the other fields are
 * queryable as jsonPayload.<field> (e.g. jsonPayload.event).
 */
export function log(data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') {
  process.stdout.write(JSON.stringify({ level, severity: SEVERITY[level], ts: new Date().toISOString(), ...data }) + '\n')
}

/**
 * Marks a log entry as an error for Google Cloud Error Reporting, which then
 * groups it and can notify (docs/monitoring.md §6). Without it, an entry is
 * only picked up if its message happens to be recognised as a stack trace.
 */
export const ERROR_REPORTING_TYPE = 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent'

/**
 * Logs a failure as ONE structured line with severity ERROR.
 *
 * `console.error(message, err)` prints the stack trace over several lines,
 * and Cloud Run may store each line as a separate entry, which Error
 * Reporting can't group. Here the whole stack trace is the `message` field
 * (Error Reporting reads it from there, and the Logs Explorer shows it as the
 * entry's summary), and `event` says where it happened.
 *
 * `context` must not contain secrets or personal data (no tokens, no message
 * text, no IPs).
 */
export function logError(event: string, err: unknown, context: Record<string, unknown> = {}) {
  const message = err instanceof Error
    ? (err.stack ?? `${err.name}: ${err.message}`)
    : `Non-Error thrown: ${String(err)}`
  log({ '@type': ERROR_REPORTING_TYPE, event, ...context, message }, 'error')
}
