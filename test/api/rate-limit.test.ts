/**
 * src/api/middleware/rate-limit.ts: per-IP, per-minute limits by route group,
 * the 429 rate_limited contract, shadow mode and the summary log.
 *
 * Every test request comes from the same socket address (Cloud Run's front
 * end, see test/helpers/app.ts); a visitor is picked with X-Forwarded-For, as
 * on Cloud Run with TRUST_PROXY_HOPS=1.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { loadFreshApp, type TestClient } from '../helpers/app.js'
import { accessToken, bearer } from '../helpers/auth.js'
import { db, resetDb } from '../fakes/db.js'
import { embedQuery } from '../fakes/embedding.js'
import { generateContentStream } from '../fakes/genai.js'
import { globalAnonUsageToday, insertResource, insertTopic } from '../helpers/fixtures.js'
import { captureLogs } from '../helpers/logs.js'
import {
  DEFAULT_MAX_TRACKED_CLIENTS, DEFAULT_RATE_LIMITS, RATE_LIMIT_ENV, rateLimit, readRateLimitConfig, routeGroup,
} from '../../src/api/middleware/rate-limit.js'
import { RATE_LIMITED_MESSAGE } from '../../src/api/limit-responses.js'
import { clientIdentity } from '../../src/api/middleware/client.js'
import { RelaySecrets } from '../../src/lib/relay.js'
import { chat_usage } from '../../src/db/schema.js'

/**
 * The limiter's clock. Date is frozen for every test (timers and the database
 * run normally), so buckets only refill when a test moves the clock: exact
 * counts don't depend on how fast the machine runs the requests.
 */
const clock = { advance: (ms: number) => vi.setSystemTime(Date.now() + ms) }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await resetDb()
})
afterEach(() => vi.useRealTimers())

const IP = '203.0.113.5'
const OTHER_IP = '198.51.100.9'
const from = (xff: string, headers: Record<string, string> = {}) => ({ 'X-Forwarded-For': xff, ...headers })
const SEARCH = '/api/v1/resources/search?q=python'

async function appWith(env: Record<string, string> = {}): Promise<TestClient> {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return loadFreshApp()
}

/** Sends `n` requests and returns their statuses (bodies are read so streams close). */
async function statuses(n: number, send: (i: number) => Promise<Response>): Promise<number[]> {
  const result: number[] = []
  for (let i = 0; i < n; i++) {
    const res = await send(i)
    await res.text()
    result.push(res.status)
  }
  return result
}

const count = (list: number[], status: number) => list.filter(s => s === status).length

describe('routeGroup', () => {
  it.each([
    ['POST', '/api/v1/chat', 'chat'],
    ['GET', '/api/v1/resources/search', 'search'],
    ['HEAD', '/api/v1/resources/search', 'search'], // Hono runs the GET handler for HEAD
    ['POST', '/api/v1/auth/firebase/login', 'login'],
    ['GET', '/api/v1/saved', 'default'],
    ['POST', '/api/v1/saved/some-id', 'default'],
    ['DELETE', '/api/v1/saved/some-id', 'default'],
    ['GET', '/health', 'default'],
    ['GET', '/wp-admin/setup.php', 'default'],
    ['GET', '/api/v1/chat', 'default'], // wrong method: 404
    ['POST', '/api/v1/resources/search', 'default'], // wrong method: 404
    ['GET', '/api/v1/resources/a/b', 'default'], // no such route
    ['POST', '/api/v1/resources/some-id', 'default'],
    ['DELETE', '/api/v1/subjects', 'default'],
    ['GET', '/api/v1/subjects/a/b', 'default'],
    ['GET', '/api/v1/auth/refresh', 'default'],
    ['GET', '/api/v1/resources/3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a60', 'default'],
    ['HEAD', '/api/v1/resources/some-id', 'default'],
    ['GET', '/api/v1/subjects', 'default'],
    ['GET', '/api/v1/subjects/tree', 'default'],
    ['GET', '/api/v1/subjects/data-science', 'default'],
    ['POST', '/api/v1/auth/refresh', 'default'],
    ['POST', '/api/v1/auth/logout', 'default'],
  ] as const)('%s %s is limited as %s', (method, path, group) => {
    expect(routeGroup(method, path)).toBe(group)
  })

  it.each([['OPTIONS', '/api/v1/chat'], ['OPTIONS', '/anything']])(
    '%s %s is not limited (CORS preflight)', (method, path) => {
      expect(routeGroup(method, path)).toBeNull()
    },
  )
})

describe('settings', () => {
  it('defaults to enforcing chat 10, search 60, login 20, everything else 120 per minute', () => {
    for (const name of ['RATE_LIMIT_MODE', ...Object.values(RATE_LIMIT_ENV)]) vi.stubEnv(name, undefined)
    expect(DEFAULT_RATE_LIMITS).toEqual({ chat: 10, search: 60, login: 20, default: 120 })
    expect(readRateLimitConfig()).toEqual({ mode: 'enforce', perMinute: DEFAULT_RATE_LIMITS })
  })

  it('reads every setting from the environment', () => {
    vi.stubEnv('RATE_LIMIT_MODE', 'shadow')
    vi.stubEnv('RATE_LIMIT_CHAT_PER_MIN', '1')
    vi.stubEnv('RATE_LIMIT_SEARCH_PER_MIN', '2')
    vi.stubEnv('RATE_LIMIT_LOGIN_PER_MIN', '0')
    vi.stubEnv('RATE_LIMIT_DEFAULT_PER_MIN', '4')
    expect(readRateLimitConfig()).toEqual({ mode: 'shadow', perMinute: { chat: 1, search: 2, login: 0, default: 4 } })
  })

  it.each([
    ['RATE_LIMIT_SEARCH_PER_MIN', 'sixty', 'RATE_LIMIT_SEARCH_PER_MIN must be a non-negative integer, got "sixty"'],
    ['RATE_LIMIT_CHAT_PER_MIN', '-1', 'RATE_LIMIT_CHAT_PER_MIN must be a non-negative integer, got "-1"'],
    ['RATE_LIMIT_MODE', 'off', 'RATE_LIMIT_MODE must be one of enforce, shadow, got "off"'],
  ])('stops the app from starting when %s is %j', async (name, value, message) => {
    await expect(appWith({ [name]: value })).rejects.toThrow(message)
  })
})

describe('enforce mode', () => {
  it('answers 60 searches per minute from one IP, then returns 429 rate_limited without searching', async () => {
    const app = await appWith()
    // A different query each time, so the embedding cache doesn't hide the calls
    const first = await statuses(60, i => app.get(`${SEARCH}${i}`, from(IP)))
    expect(first).toEqual(Array(60).fill(200))

    const res = await app.get(`${SEARCH}-over-the-limit`, from(IP))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('1') // one search per second
    expect(await res.json()).toEqual({
      error: 'Too many requests',
      code: 'rate_limited',
      message: RATE_LIMITED_MESSAGE,
      retryAfter: 1,
      limitReached: false,
    })
    expect(embedQuery).toHaveBeenCalledTimes(60) // the rejected search cost nothing
  })

  it('lets the client back in once tokens refill', async () => {
    const app = await appWith()
    await statuses(60, () => app.get(SEARCH, from(IP)))
    expect((await app.get(SEARCH, from(IP))).status).toBe(429)

    clock.advance(1_000)
    expect((await app.get(SEARCH, from(IP))).status).toBe(200)
    expect((await app.get(SEARCH, from(IP))).status).toBe(429)

    clock.advance(60_000)
    expect(count(await statuses(61, () => app.get(SEARCH, from(IP))), 200)).toBe(60)
  })

  it('keeps each IP separate', async () => {
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '2' })
    expect(await statuses(3, () => app.get(SEARCH, from(IP)))).toEqual([200, 200, 429])
    expect(await statuses(2, () => app.get(SEARCH, from(OTHER_IP)))).toEqual([200, 200])
  })

  it('ignores X-Forwarded-For entries the client wrote itself', async () => {
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '5' })
    const result = await statuses(10, i => app.get(SEARCH, from(`10.0.${i}.1, ${IP}`)))
    expect(count(result, 200)).toBe(5)
  })

  it('counts IPv6 clients per /64, so rotating addresses within it does not help', async () => {
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '5' })
    const result = await statuses(10, i => app.get(SEARCH, from(`2001:db8:1:2::${(i + 1).toString(16)}`)))
    expect(count(result, 200)).toBe(5)
  })

  it('counts HEAD and percent-encoded paths as searches (both run the search handler)', async () => {
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '3' })
    const result = await statuses(4, i => i % 2 === 0
      ? app.request(`${SEARCH}${i}`, { method: 'HEAD', headers: from(IP) })
      : app.get(`/api/v1/resources/%73earch?q=python${i}`, from(IP)))
    expect(result).toEqual([200, 200, 200, 429])
    expect(embedQuery).toHaveBeenCalledTimes(3)
  })

  it('keeps route groups separate: using up search leaves chat, login and the rest alone', async () => {
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '1' })
    await statuses(2, () => app.get(SEARCH, from(IP)))
    expect((await app.get(SEARCH, from(IP))).status).toBe(429)

    expect((await app.get('/health', from(IP))).status).toBe(200)
    expect((await app.post('/api/v1/auth/firebase/login', {}, from(IP))).status).toBe(400)
    const chat = await app.post('/api/v1/chat', { message: 'hi' }, from(IP, { 'X-Session-ID': randomUUID() }))
    expect(chat.status).toBe(200)
    await chat.text()
  })

  it('limits login to 20 per minute, counting failed attempts', async () => {
    const app = await appWith()
    const result = await statuses(21, () => app.post('/api/v1/auth/firebase/login', { idToken: 'bad' }, from(IP)))
    expect(result).toEqual([...Array(20).fill(401), 429])
  })

  it('turns a flood away before reading its bodies', async () => {
    const app = await appWith({ RATE_LIMIT_LOGIN_PER_MIN: '1' })
    await statuses(1, () => app.post('/api/v1/auth/firebase/login', {}, from(IP)))
    const res = await app.post('/api/v1/auth/firebase/login', 'x'.repeat(1024 * 1024), from(IP))
    expect(res.status).toBe(429) // not 413: the oversized body was never looked at
  })

  it('limits everything else (saved, health, unknown paths) to 120 per minute in one shared budget', async () => {
    const app = await appWith()
    const token = await accessToken('fb-user-1')
    const result = await statuses(121, i => [
      () => app.get('/health', from(IP)),
      () => app.get('/api/v1/saved', from(IP, bearer(token))),
      () => app.get('/no-such-path', from(IP)),
    ][i % 3]!())
    expect(result.slice(0, 120).every(s => s !== 429)).toBe(true)
    expect(result[120]).toBe(429)
  })

  it('limits resource detail, subjects, refresh and logout in the shared "everything else" budget', async () => {
    const app = await appWith({ RATE_LIMIT_DEFAULT_PER_MIN: '6' })
    const resource = await insertResource()
    await insertTopic({ slug: 'data-science' })
    const calls: Array<() => Promise<Response>> = [
      () => app.get(`/api/v1/resources/${resource.id}`, from(IP)),
      () => app.get('/api/v1/subjects', from(IP)),
      () => app.get('/api/v1/subjects/tree', from(IP)),
      () => app.get('/api/v1/subjects/data-science', from(IP)),
      () => app.post('/api/v1/auth/refresh', undefined, from(IP)),
      () => app.post('/api/v1/auth/logout', undefined, from(IP)),
    ]
    const results = await statuses(6, i => calls[i]!())
    expect(results).not.toContain(429) // one of each uses up the budget of 6
    for (const call of calls) expect((await call()).status).toBe(429)
  })

  it('answers CORS preflights even when the client is over its limit', async () => {
    const app = await appWith({ RATE_LIMIT_CHAT_PER_MIN: '1' })
    await statuses(2, () => app.post('/api/v1/chat', { message: 'hi' }, from(IP, { 'X-Session-ID': randomUUID() })))
    const res = await app.request('/api/v1/chat', {
      method: 'OPTIONS',
      headers: from(IP, { Origin: 'http://localhost:3001', 'Access-Control-Request-Method': 'POST' }),
    })
    expect(res.status).toBe(204)
  })

  it('sends CORS headers with the 429, and lets frontend code read Retry-After', async () => {
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '1' })
    const origin = { Origin: 'http://localhost:3001' }
    await statuses(1, () => app.get(SEARCH, from(IP, origin)))
    const res = await app.get(SEARCH, from(IP, origin))
    expect(res.status).toBe(429)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001')
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After')
  })

  it('turns off a group set to 0, and only that group', async () => {
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '0', RATE_LIMIT_DEFAULT_PER_MIN: '1' })
    expect(await statuses(100, () => app.get(SEARCH, from(IP)))).not.toContain(429)
    expect(await statuses(2, () => app.get('/health', from(IP)))).toEqual([200, 429])
  })

  it('lets requests through when the client IP cannot be determined, and reports them once per minute', async () => {
    const logs = captureLogs()
    const app = await appWith({ RATE_LIMIT_DEFAULT_PER_MIN: '1' })
    expect(await statuses(5, () => app.get('/health', from(`${IP}, not-an-ip`)))).toEqual(Array(5).fill(200))
    expect(logs().filter(l => l.event === 'client_ip_unknown')).toEqual([])

    clock.advance(60_000)
    await app.get('/health', from(OTHER_IP))
    expect(logs().filter(l => l.event === 'client_ip_unknown')).toEqual([
      expect.objectContaining({ route: 'rate_limit', requests: 5, trust_proxy_hops: 1, severity: 'WARNING' }),
    ])
  })

  describe('chat', () => {
    const anonymous = (xff: string) => from(xff, { 'X-Session-ID': randomUUID() })

    it('answers 10 questions per minute from one IP, then returns 429 rate_limited, which does not use up daily questions', async () => {
      const app = await appWith()
      const result = await statuses(11, () => app.post('/api/v1/chat', { message: 'hi' }, anonymous(IP)))
      expect(result).toEqual([...Array(10).fill(200), 429])
      expect(generateContentStream).toHaveBeenCalledTimes(10)
      expect(await globalAnonUsageToday()).toBe(10)

      const res = await app.post('/api/v1/chat', { message: 'hi' }, anonymous(IP))
      expect(await res.json()).toMatchObject({ code: 'rate_limited', limitReached: false })
    })

    it('applies to signed-in users too', async () => {
      const app = await appWith({ RATE_LIMIT_CHAT_PER_MIN: '2' })
      const headers = from(IP, bearer(await accessToken('fb-user-1')))
      expect(await statuses(3, () => app.post('/api/v1/chat', { message: 'hi' }, headers))).toEqual([200, 200, 429])
    })

    it('works with the daily limits: a client at the per-minute limit still reaches the daily IP limit over time', async () => {
        const app = await appWith()
      const ask = () => app.post('/api/v1/chat', { message: 'hi' }, anonymous(IP))

      expect(count(await statuses(15, ask), 200)).toBe(10)
      clock.advance(60_000)
      expect(count(await statuses(15, ask), 200)).toBe(10)
      clock.advance(60_000)

      const res = await ask()
      expect(res.status).toBe(429)
      expect(await res.json()).toMatchObject({ code: 'daily_limit', scope: 'ip', limitReached: true })
      expect((await db.select().from(chat_usage)).filter(r => r.identity_type === 'ip')[0]!.count).toBe(20)
    })
  })
})

describe('shadow mode', () => {
  it('lets every request through and logs what enforce mode would have rejected, once per minute', async () => {
    const logs = captureLogs()
    const app = await appWith({ RATE_LIMIT_MODE: 'shadow' })

    expect(await statuses(70, i => app.get(`${SEARCH}${i}`, from(IP)))).toEqual(Array(70).fill(200))
    expect(embedQuery).toHaveBeenCalledTimes(70)
    expect(logs().filter(l => l.event === 'rate_limit_summary')).toEqual([]) // not one line per request

    clock.advance(60_000)
    await app.get('/health', from(OTHER_IP))
    const summaries = logs().filter(l => l.event === 'rate_limit_summary')
    expect(summaries).toEqual([{
      event: 'rate_limit_summary',
      level: 'warn',
      severity: 'WARNING',
      ts: expect.any(String),
      mode: 'shadow',
      over_limit: 10,
      by_group: { search: 10 },
      clients: 1,
      clients_capped: false,
      max_per_client: 10,
      window_start: expect.any(String),
    }])
  })

  it('counts exactly what enforce mode rejects', async () => {
    const shadow = await appWith({ RATE_LIMIT_MODE: 'shadow', RATE_LIMIT_LOGIN_PER_MIN: '3' })
    const logs = captureLogs()
    await statuses(8, () => shadow.post('/api/v1/auth/firebase/login', {}, from(IP)))
    clock.advance(60_000)
    await shadow.get('/health', from(IP))
    expect(logs().find(l => l.event === 'rate_limit_summary')).toMatchObject({ over_limit: 5 })

    const enforce = await appWith({ RATE_LIMIT_MODE: 'enforce', RATE_LIMIT_LOGIN_PER_MIN: '3' })
    const result = await statuses(8, () => enforce.post('/api/v1/auth/firebase/login', {}, from(IP)))
    expect(count(result, 429)).toBe(5)
  })
})

describe('summary log', () => {
  it('reports groups and distinct clients without logging any IP', async () => {
    const logs = captureLogs()
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '1', RATE_LIMIT_LOGIN_PER_MIN: '1' })

    await statuses(4, () => app.get(SEARCH, from(IP))) // 3 over
    await statuses(2, () => app.get(SEARCH, from(OTHER_IP))) // 1 over
    await statuses(3, () => app.post('/api/v1/auth/firebase/login', {}, from(IP))) // 2 over
    clock.advance(60_000)
    await app.get('/health', from('192.0.2.1'))

    const lines = logs().filter(l => l.event === 'rate_limit_summary')
    expect(lines).toEqual([expect.objectContaining({
      mode: 'enforce', over_limit: 6, by_group: { search: 4, login: 2 }, clients: 2, max_per_client: 5,
    })])
    expect(JSON.stringify(lines)).not.toMatch(/203\.0\.113|198\.51\.100/)
  })

  it('writes nothing when no request was over the limit', async () => {
    const logs = captureLogs()
    const app = await appWith()
    await statuses(5, () => app.get(SEARCH, from(IP)))
    clock.advance(60_000)
    await app.get(SEARCH, from(IP))
    expect(logs().filter(l => l.event === 'rate_limit_summary' || l.event === 'client_ip_unknown')).toEqual([])
  })

  it('starts a new window after each summary', async () => {
    const logs = captureLogs()
    const app = await appWith({ RATE_LIMIT_SEARCH_PER_MIN: '1' })
    await statuses(3, () => app.get(SEARCH, from(IP))) // 2 over
    clock.advance(30_000)
    await app.get('/health', from(OTHER_IP)) // window still open: nothing logged
    expect(logs().filter(l => l.event === 'rate_limit_summary')).toHaveLength(0)

    clock.advance(30_000)
    // The first request logs the first window. One token has refilled, so one of these two is over.
    await statuses(2, () => app.get(SEARCH, from(IP)))
    clock.advance(60_000)
    await app.get('/health', from(OTHER_IP))
    expect(logs().filter(l => l.event === 'rate_limit_summary').map(l => l.over_limit)).toEqual([2, 1])
  })

  it('tracks at most 10,000 distinct clients per window, and says when it hit that cap', async () => {
    expect(DEFAULT_MAX_TRACKED_CLIENTS).toBe(10_000)
    const logs = captureLogs()
    let now = 0
    const app = new Hono()
    app.use('*', clientIdentity({ hops: 1, relays: new RelaySecrets([]) }))
    app.use('*', rateLimit(
      { mode: 'enforce', perMinute: { chat: 1, search: 1, login: 1, default: 1 } },
      { hops: 1, now: () => now, maxTrackedClients: 2 },
    ))
    app.get('*', c => c.text('ok'))
    const get = (xff: string) => app.request('/x', { headers: { 'X-Forwarded-For': xff } })

    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
      await get(ip)
      await get(ip) // over the limit
      await get(ip) // over the limit
    }
    now = 60_000
    await get('192.0.2.9')
    expect(logs().find(l => l.event === 'rate_limit_summary')).toMatchObject({
      over_limit: 6, clients: 2, clients_capped: true, max_per_client: 2,
    })
  })

  it('fails loudly if the clientIdentity middleware is missing (rather than silently not limiting)', async () => {
    const app = new Hono()
    app.use('*', rateLimit({ mode: 'enforce', perMinute: DEFAULT_RATE_LIMITS }, { hops: 1 }))
    app.get('*', c => c.text('ok'))
    app.onError((err, c) => c.text(err.message, 500))
    const res = await app.request('/x')
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('rateLimit needs the clientIdentity middleware registered before it')
  })

  it('never counts OPTIONS, even without the CORS middleware in front', async () => {
    const app = new Hono()
    app.use('*', clientIdentity({ hops: 1, relays: new RelaySecrets([]) }))
    app.use('*', rateLimit({ mode: 'enforce', perMinute: { chat: 1, search: 1, login: 1, default: 1 } }, { hops: 1 }))
    app.options('*', c => c.body(null, 204))
    const statuses = []
    for (let i = 0; i < 3; i++) statuses.push((await app.request('/x', { method: 'OPTIONS', headers: { 'X-Forwarded-For': IP } })).status)
    expect(statuses).toEqual([204, 204, 204])
  })
})
