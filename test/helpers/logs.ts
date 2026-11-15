/**
 * Captures structured log lines written by src/lib/logger.ts (JSON on stdout).
 * The spy is undone after each test by vi.restoreAllMocks (test/setup.ts).
 */
import { vi } from 'vitest'

export function captureLogs(): () => Array<Record<string, unknown>> {
  // May return the spy test/setup.ts already installed; only lines written
  // from now on are returned.
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const start = write.mock.calls.length
  return () =>
    write.mock.calls
      .slice(start)
      .map(([chunk]) => String(chunk))
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The structured error lines (logError in src/lib/logger.ts) for one event. */
export function errorLogs(entries: Array<Record<string, unknown>>, event: string): Array<Record<string, unknown>> {
  return entries.filter(e => e.event === event && e.severity === 'ERROR')
}
