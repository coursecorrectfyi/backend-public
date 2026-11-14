/**
 * Captures structured log lines written by src/lib/logger.ts (JSON on stdout).
 * The spy is undone after each test by vi.restoreAllMocks (test/setup.ts).
 */
import { vi } from 'vitest'

export function captureLogs(): () => Array<Record<string, unknown>> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return () =>
    write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
}
