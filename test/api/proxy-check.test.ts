/**
 * src/api/middleware/proxy-check.ts (R2): warns when TRUST_PROXY_HOPS doesn't
 * match the X-Forwarded-For shape of the traffic actually arriving.
 *
 * Test requests come from Cloud Run's front end (socket 169.254.1.1, see
 * test/helpers/app.ts). A request "as Cloud Run delivers it" therefore has
 * exactly one X-Forwarded-For entry: the visitor's address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadFreshApp, type TestClient } from '../helpers/app.js'
import { resetDb } from '../fakes/db.js'
import { captureLogs } from '../helpers/logs.js'
import { MIN_REQUESTS } from '../../src/api/middleware/proxy-check.js'

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await resetDb()
})
afterEach(() => vi.useRealTimers())

async function appWithHops(hops: string): Promise<TestClient> {
  vi.stubEnv('TRUST_PROXY_HOPS', hops)
  vi.stubEnv('RATE_LIMIT_DEFAULT_PER_MIN', '0') // many requests from one IP
  return loadFreshApp()
}

/** Sends `n` requests with the given X-Forwarded-For (undefined = no header), then ends the window. */
async function windowOf(app: TestClient, n: number, xff: (i: number) => string | undefined) {
  for (let i = 0; i < n; i++) {
    const value = xff(i)
    await app.get('/health', value === undefined ? {} : { 'X-Forwarded-For': value })
  }
  advance(60_000)
  await app.get('/health', { 'X-Forwarded-For': '192.0.2.1' }) // writes the finished window's log line
}

const mismatches = (logs: Array<Record<string, unknown>>) => logs.filter(l => l.event === 'proxy_hops_mismatch')
const visitor = (i: number) => `203.0.113.${i + 1}`

describe('proxy_hops_mismatch', () => {
  it('stays quiet for normal Cloud Run traffic (one entry per request), including a few odd ones', async () => {
    const logs = captureLogs()
    const app = await appWithHops('1')
    // 1 in 4 requests carries an extra entry (a corporate proxy, or a script faking one)
    await windowOf(app, 40, i => (i % 4 === 0 ? `10.1.1.1, ${visitor(i)}` : visitor(i)))
    expect(mismatches(logs())).toEqual([])
  })

  it('warns when most requests have fewer entries than TRUST_PROXY_HOPS (setting too high, or the proxy is bypassed)', async () => {
    const logs = captureLogs()
    const app = await appWithHops('2') // e.g. configured for a load balancer that isn't there
    await windowOf(app, 30, visitor)
    expect(mismatches(logs())).toEqual([expect.objectContaining({
      severity: 'WARNING',
      trust_proxy_hops: 2,
      likely: 'hops_too_high_or_proxy_bypassed',
      requests: 30,
      fewer_entries: 30,
      more_entries: 0,
      window_start: expect.any(String),
    })])
  })

  it('warns when requests arrive with no X-Forwarded-For at all while a proxy is expected', async () => {
    const logs = captureLogs()
    const app = await appWithHops('1') // the default, e.g. `npm run dev` without TRUST_PROXY_HOPS=0
    await windowOf(app, 30, () => undefined)
    expect(mismatches(logs())).toEqual([expect.objectContaining({ likely: 'hops_too_high_or_proxy_bypassed', fewer_entries: 30 })])
  })

  it('warns when most requests have more entries than TRUST_PROXY_HOPS (a proxy was added: setting too low)', async () => {
    const logs = captureLogs()
    const app = await appWithHops('1')
    // A load balancer in front of Cloud Run appends the visitor, then Cloud Run appends the load balancer
    await windowOf(app, 30, i => `${visitor(i)}, 35.191.0.1`)
    expect(mismatches(logs())).toEqual([expect.objectContaining({ likely: 'hops_too_low', more_entries: 30, fewer_entries: 0 })])
  })

  it('warns when the address picked as the client is private (a proxy\'s own address)', async () => {
    const logs = captureLogs()
    const app = await appWithHops('1')
    // e.g. an internal proxy that appends its own private address
    await windowOf(app, 30, () => '10.8.0.4')
    expect(mismatches(logs())).toEqual([expect.objectContaining({ likely: 'hops_too_low', non_public_address: 30 })])
  })

  it('does not check for private addresses with TRUST_PROXY_HOPS=0 (nothing in front, e.g. localhost)', async () => {
    const logs = captureLogs()
    const app = await appWithHops('0') // the socket address (169.254.1.1 here) is the client
    await windowOf(app, 30, () => undefined)
    expect(mismatches(logs())).toEqual([])
  })

  it(`needs at least ${MIN_REQUESTS} requests in the window before judging`, async () => {
    const logs = captureLogs()
    const app = await appWithHops('2')
    await windowOf(app, MIN_REQUESTS - 2, visitor) // + the request that ends the window = MIN_REQUESTS - 1
    expect(mismatches(logs())).toEqual([])
  })

  it('writes at most one line per window, however many requests differ', async () => {
    const logs = captureLogs()
    const app = await appWithHops('2')
    for (let i = 0; i < 200; i++) await app.get('/health', { 'X-Forwarded-For': visitor(i % 250) })
    expect(mismatches(logs())).toEqual([])
    advance(60_000)
    await app.get('/health', { 'X-Forwarded-For': visitor(0) })
    await app.get('/health', { 'X-Forwarded-For': visitor(0) })
    expect(mismatches(logs())).toHaveLength(1)
  })

  it('never logs addresses', async () => {
    const logs = captureLogs()
    const app = await appWithHops('1')
    await windowOf(app, 30, i => `${visitor(i)}, 35.191.0.1`)
    expect(JSON.stringify(mismatches(logs()))).not.toMatch(/203\.0\.113|35\.191/)
  })
})
