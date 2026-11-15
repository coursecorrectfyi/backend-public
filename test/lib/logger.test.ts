/** src/lib/logger.ts: one JSON line per event, with a severity Cloud Logging understands. */
import { describe, expect, it, vi } from 'vitest'
import { ERROR_REPORTING_TYPE, log, logError } from '../../src/lib/logger.js'

function captureLine(fn: () => void): Record<string, unknown> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  fn()
  expect(write).toHaveBeenCalledTimes(1)
  const line = String(write.mock.calls[0]![0])
  write.mockRestore() // so the next captureLine in the same test starts counting from zero
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

describe('logError', () => {
  it('writes one line with severity ERROR, the Error Reporting type, the event, and the stack trace as the message', () => {
    const err = new Error('connection refused')
    const entry = captureLine(() => logError('health_check_failed', err))
    expect(entry).toEqual({
      '@type': ERROR_REPORTING_TYPE,
      level: 'error',
      severity: 'ERROR',
      ts: expect.any(String),
      event: 'health_check_failed',
      message: err.stack,
    })
    expect(ERROR_REPORTING_TYPE).toBe('type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent')
    expect(entry['message']).toMatch(/^Error: connection refused\n\s+at /) // the format Error Reporting parses
  })

  it('adds context fields, which cannot overwrite the message', () => {
    const entry = captureLine(() => logError('x', new Error('boom'), { route: '/api/v1/saved', message: 'ignored' }))
    expect(entry).toMatchObject({ event: 'x', route: '/api/v1/saved' })
    expect(entry['message']).toMatch(/^Error: boom/)
  })

  it('handles errors without a stack, and values that are not errors', () => {
    const noStack = new TypeError('bad')
    noStack.stack = undefined
    expect(captureLine(() => logError('x', noStack))['message']).toBe('TypeError: bad')
    expect(captureLine(() => logError('x', 'just a string'))['message']).toBe('Non-Error thrown: just a string')
    expect(captureLine(() => logError('x', { code: 42 }))['message']).toBe('Non-Error thrown: [object Object]')
  })
})
