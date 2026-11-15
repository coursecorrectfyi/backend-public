/**
 * src/api/health.ts: GET /health with a short cache and a time limit on the
 * database check. (Basic 200/503 and not leaking details: test/index.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApp } from '../helpers/app.js'
import { db, resetDb } from '../fakes/db.js'
import { captureLogs, errorLogs } from '../helpers/logs.js'
import { DB_CHECK_TIMEOUT_MS, HEALTH_CACHE_MS } from '../../src/api/health.js'

beforeEach(resetDb)
afterEach(() => { vi.useRealTimers() })

/** Fakes the clock and timers (the database is mocked in these tests, so nothing else needs real timers). */
function fakeTime() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
}
const status = async (app: Awaited<ReturnType<typeof loadApp>>) => (await app.get('/health')).status

describe('GET /health: cache', () => {
  it('checks the database at most once every 5 seconds', async () => {
    fakeTime()
    const app = await loadApp()
    const execute = vi.spyOn(db, 'execute')
    expect([await status(app), await status(app), await status(app)]).toEqual([200, 200, 200])
    expect(execute).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(HEALTH_CACHE_MS - 1)
    await status(app)
    expect(execute).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await status(app)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(HEALTH_CACHE_MS).toBe(5_000)
  })

  it('shares one check between simultaneous requests', async () => {
    const app = await loadApp()
    const execute = vi.spyOn(db, 'execute')
    const results = await Promise.all(Array.from({ length: 10 }, () => status(app)))
    expect(results).toEqual(Array(10).fill(200))
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('caches a failure too (one log per failed check, not per request), and recovers after 5 seconds', async () => {
    fakeTime()
    const app = await loadApp()
    const logs = captureLogs()
    const execute = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    expect([await status(app), await status(app)]).toEqual([503, 503])
    expect(errorLogs(logs(), 'health_check_failed')).toHaveLength(1)

    vi.advanceTimersByTime(HEALTH_CACHE_MS)
    expect(await status(app)).toBe(200)
    expect(execute).toHaveBeenCalledTimes(2)
  })
})

describe('GET /health: time limit', () => {
  it('answers 503 after 3 seconds when the database hangs, and logs a timeout', async () => {
    fakeTime()
    const app = await loadApp()
    const logs = captureLogs()
    vi.spyOn(db, 'execute').mockReturnValue(new Promise(() => {}) as never)
    const pending = app.get('/health')
    await vi.advanceTimersByTimeAsync(DB_CHECK_TIMEOUT_MS)
    const res = await pending
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'error', message: 'Database unavailable' })
    expect(errorLogs(logs(), 'health_check_failed')).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/^DatabaseCheckTimeout: database did not answer SELECT 1 within 3000 ms/) }),
    ])
    expect(DB_CHECK_TIMEOUT_MS).toBe(3_000)
  })

  it('does not send another query while an earlier one is still hanging, and checks again once it settles', async () => {
    fakeTime()
    const app = await loadApp()
    let settle!: () => void
    const execute = vi.spyOn(db, 'execute').mockReturnValueOnce(new Promise<void>(r => { settle = r }) as never)

    const first = app.get('/health')
    await vi.advanceTimersByTimeAsync(DB_CHECK_TIMEOUT_MS)
    expect((await first).status).toBe(503)

    vi.advanceTimersByTime(HEALTH_CACHE_MS)
    expect(await status(app)).toBe(503) // still hanging: reported without a new query
    expect(execute).toHaveBeenCalledTimes(1)

    settle()
    await Promise.resolve()
    vi.advanceTimersByTime(HEALTH_CACHE_MS)
    expect(await status(app)).toBe(200)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('recovers after a synchronous failure (not stuck thinking a query is still pending)', async () => {
    fakeTime()
    const app = await loadApp()
    vi.spyOn(db, 'execute').mockImplementationOnce(() => { throw new Error('pool destroyed') })
    expect(await status(app)).toBe(503)
    vi.advanceTimersByTime(HEALTH_CACHE_MS)
    expect(await status(app)).toBe(200)
  })
})
