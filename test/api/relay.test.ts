/**
 * Trusted relays through the real app: the Next.js server calls the API for
 * visitors with X-Relay-Secret + X-Visitor-IP, and per-visitor limits count
 * each visitor, not the server (src/lib/relay.ts, src/api/middleware/client.ts).
 *
 * Every test request reaches the app through Cloud Run's front end (see
 * test/helpers/app.ts); FRONTEND is the relay's own address as the front end
 * reports it in X-Forwarded-For.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadFreshApp, type TestClient } from '../helpers/app.js'
import { resetDb } from '../fakes/db.js'
import { captureLogs } from '../helpers/logs.js'

const SECRET = 'r'.repeat(48)
const OLD_SECRET = 'q'.repeat(48)
const FRONTEND = '34.1.2.3'

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await resetDb()
})
afterEach(() => vi.useRealTimers())

async function appWith(env: Record<string, string>): Promise<TestClient> {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return loadFreshApp()
}

/** A request from the frontend server, optionally relaying for a visitor. */
const fromFrontend = (relay?: { secret?: string; visitor?: string }) => ({
  'X-Forwarded-For': FRONTEND,
  ...(relay?.secret !== undefined ? { 'X-Relay-Secret': relay.secret } : {}),
  ...(relay?.visitor !== undefined ? { 'X-Visitor-IP': relay.visitor } : {}),
})

async function statuses(n: number, send: () => Promise<Response>): Promise<number[]> {
  const result: number[] = []
  for (let i = 0; i < n; i++) {
    const res = await send()
    await res.text()
    result.push(res.status)
  }
  return result
}

describe('per-visitor limits through a trusted relay', () => {
  it('gives each relayed visitor their own budget, although all calls come from the frontend server', async () => {
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET, RATE_LIMIT_DEFAULT_PER_MIN: '2' })
    const visitorA = () => app.get('/api/v1/subjects', fromFrontend({ secret: SECRET, visitor: '203.0.113.1' }))
    const visitorB = () => app.get('/api/v1/subjects', fromFrontend({ secret: SECRET, visitor: '203.0.113.2' }))
    expect(await statuses(3, visitorA)).toEqual([200, 200, 429])
    expect(await statuses(2, visitorB)).toEqual([200, 200])
  })

  it('counts a relayed visitor and the same visitor calling directly as one client', async () => {
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET, RATE_LIMIT_DEFAULT_PER_MIN: '2' })
    await statuses(1, () => app.get('/api/v1/subjects', fromFrontend({ secret: SECRET, visitor: '203.0.113.1' })))
    await statuses(1, () => app.get('/api/v1/subjects', { 'X-Forwarded-For': '203.0.113.1' })) // the browser itself
    expect((await app.get('/api/v1/subjects', { 'X-Forwarded-For': '203.0.113.1' })).status).toBe(429)
  })

  it('without the relay headers, every visitor is counted as the frontend server (the failure the headers prevent)', async () => {
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET, RATE_LIMIT_DEFAULT_PER_MIN: '2' })
    expect(await statuses(3, () => app.get('/api/v1/subjects', fromFrontend()))).toEqual([200, 200, 429])
  })

  it('ignores X-Visitor-IP without the secret, so a client can\'t pick its own identity', async () => {
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET, RATE_LIMIT_SEARCH_PER_MIN: '2' })
    let i = 0
    const forged = () => app.get('/api/v1/resources/search?q=python', { 'X-Forwarded-For': '198.51.100.9', 'X-Visitor-IP': `203.0.113.${++i}` })
    expect(await statuses(3, forged)).toEqual([200, 200, 429])
  })

  it('accepts both secrets while rotating', async () => {
    const app = await appWith({ TRUSTED_RELAY_SECRETS: `${SECRET} ${OLD_SECRET}`, RATE_LIMIT_DEFAULT_PER_MIN: '1' })
    expect((await app.get('/health', fromFrontend({ secret: SECRET, visitor: '203.0.113.1' }))).status).toBe(200)
    expect((await app.get('/health', fromFrontend({ secret: OLD_SECRET, visitor: '203.0.113.2' }))).status).toBe(200)
  })

  it('counts anonymous chat questions against the relayed visitor\'s daily network limit', async () => {
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET, ANON_IP_DAILY_LIMIT: '1', RATE_LIMIT_CHAT_PER_MIN: '0' })
    const ask = (visitor: string) => app.post('/api/v1/chat', { message: 'hi' }, {
      ...fromFrontend({ secret: SECRET, visitor }), 'X-Session-ID': randomUUID(),
    })
    expect(await statuses(1, () => ask('203.0.113.1'))).toEqual([200])
    expect(await statuses(1, () => ask('203.0.113.1'))).toEqual([429])
    expect(await statuses(1, () => ask('203.0.113.2'))).toEqual([200]) // another visitor, same server
  })

  it('limits every route, including the ones only servers used to call', async () => {
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET, RATE_LIMIT_DEFAULT_PER_MIN: '1' })
    const headers = fromFrontend({ secret: SECRET, visitor: '203.0.113.1' })
    await statuses(1, () => app.post('/api/v1/auth/refresh', undefined, headers))
    expect((await app.post('/api/v1/auth/logout', undefined, headers)).status).toBe(429)
  })
})

describe('relay problems', () => {
  const relayLogs = (logs: Array<Record<string, unknown>>) => logs.filter(l => l.event === 'relay_auth_failed')
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

  it('counts a call with a wrong secret, no visitor IP or an invalid one as the frontend server, and reports it once a minute', async () => {
    const logs = captureLogs()
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET, RATE_LIMIT_DEFAULT_PER_MIN: '3' })
    const sends = [
      () => app.get('/api/v1/subjects', fromFrontend({ secret: 'w'.repeat(48), visitor: '203.0.113.1' })),
      () => app.get('/api/v1/subjects', fromFrontend({ secret: 'w'.repeat(48), visitor: '203.0.113.2' })),
      () => app.get('/api/v1/subjects', fromFrontend({ secret: SECRET })),
      () => app.get('/api/v1/subjects', fromFrontend({ secret: SECRET, visitor: 'not-an-ip' })),
    ]
    const results: number[] = []
    for (const send of sends) results.push(...await statuses(1, send))
    expect(results).toEqual([200, 200, 200, 429]) // all four counted as FRONTEND, budget 3
    expect(relayLogs(logs())).toEqual([])

    advance(60_000)
    await app.get('/health', { 'X-Forwarded-For': '192.0.2.1' })
    const lines = relayLogs(logs())
    expect(lines).toEqual([expect.objectContaining({
      severity: 'WARNING', invalid_secret: 2, missing_visitor_ip: 1, invalid_visitor_ip: 1, window_start: expect.any(String),
    })])
    expect(JSON.stringify(lines)).not.toMatch(/www|rrr|203\.0\.113|34\.1\.2\.3/) // no secrets, no addresses
  })

  it('reports relay calls when the API trusts no relay (the frontend has a secret, the API doesn\'t)', async () => {
    const logs = captureLogs()
    const app = await appWith({})
    await app.get('/health', fromFrontend({ secret: SECRET, visitor: '203.0.113.1' }))
    advance(60_000)
    await app.get('/health')
    expect(relayLogs(logs())).toEqual([expect.objectContaining({ invalid_secret: 1 })])
  })

  it('reports a private visitor IP (the relay probably picked its proxy\'s address) but still uses it', async () => {
    const logs = captureLogs()
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET, RATE_LIMIT_DEFAULT_PER_MIN: '1' })
    await statuses(1, () => app.get('/health', fromFrontend({ secret: SECRET, visitor: '169.254.1.1' })))
    expect((await app.get('/health', fromFrontend())).status).toBe(200) // FRONTEND's own budget is untouched
    advance(60_000)
    await app.get('/health', { 'X-Forwarded-For': '192.0.2.1' })
    expect(relayLogs(logs())).toEqual([expect.objectContaining({ non_public_visitor_ip: 1 })])
  })

  it('writes nothing when every relay call is valid', async () => {
    const logs = captureLogs()
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET })
    await app.get('/health', fromFrontend({ secret: SECRET, visitor: '203.0.113.1' }))
    advance(60_000)
    await app.get('/health', fromFrontend({ secret: SECRET, visitor: '203.0.113.1' }))
    expect(relayLogs(logs())).toEqual([])
  })
})

describe('settings and browsers', () => {
  it('stops the app from starting with a secret shorter than 32 characters', async () => {
    await expect(appWith({ TRUSTED_RELAY_SECRETS: 'short' })).rejects.toThrow('TRUSTED_RELAY_SECRETS')
  })

  it('does not let browsers send the relay headers cross-origin (not in the CORS allow list)', async () => {
    const app = await appWith({ TRUSTED_RELAY_SECRETS: SECRET })
    const res = await app.request('/api/v1/subjects', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3001',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-relay-secret, x-visitor-ip',
      },
    })
    const allowed = (res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase()
    expect(allowed).not.toContain('x-relay-secret')
    expect(allowed).not.toContain('x-visitor-ip')
  })
})
