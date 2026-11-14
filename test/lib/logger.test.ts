/** src/lib/logger.ts: one JSON line per event, with a severity Cloud Logging understands. */
import { describe, expect, it, vi } from 'vitest'
import { log } from '../../src/lib/logger.js'

function captureLine(fn: () => void): Record<string, unknown> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  fn()
  expect(write).toHaveBeenCalledTimes(1)
  const line = String(write.mock.calls[0]![0])
  expect(line.endsWith('\n')).toBe(true)
  return JSON.parse(line) as Record<string, unknown>
}

describe('log', () => {
  it.each([
    ['info', 'INFO'],
    ['warn', 'WARNING'],
    ['error', 'ERROR'],
  ] as const)('maps level %s to Cloud Logging severity %s', (level, severity) => {
    expect(captureLine(() => log({ event: 'x' }, level))).toMatchObject({ level, severity, event: 'x' })
  })

  it('defaults to info and adds an ISO timestamp', () => {
    const entry = captureLine(() => log({ event: 'started', count: 3 }))
    expect(entry).toMatchObject({ level: 'info', severity: 'INFO', event: 'started', count: 3 })
    expect(new Date(entry['ts'] as string).toISOString()).toBe(entry['ts'])
  })
})
