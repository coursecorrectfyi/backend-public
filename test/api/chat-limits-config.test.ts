/**
 * Deploy-time settings for the shared chat limits (read once when the app
 * starts): ANON_GLOBAL_DAILY_LIMIT, ANON_IP_DAILY_LIMIT,
 * SIGNED_IN_GLOBAL_DAILY_LIMIT and TRUST_PROXY_HOPS.
 * Each test re-imports the app with its own settings (see docs/deployment-gcp.md).
 */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { loadFreshApp, type TestClient } from '../helpers/app.js'
import { accessToken, bearer } from '../helpers/auth.js'
import { db, resetDb } from '../fakes/db.js'
import { failWith, generateContentStream } from '../fakes/genai.js'
import { embedQuery } from '../fakes/embedding.js'
import { chatUsageToday, globalAnonUsageToday } from '../helpers/fixtures.js'
import { captureLogs } from '../helpers/logs.js'
import { chat_usage } from '../../src/db/schema.js'

beforeEach(resetDb)

async function appWith(env: Record<string, string>): Promise<TestClient> {
  // The per-minute chat limit is a separate layer (rate-limit.test.ts). Off here
  // so tests can ask more questions than it allows per minute.
  vi.stubEnv('RATE_LIMIT_CHAT_PER_MIN', '0')
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return loadFreshApp()
}

/** Asks one anonymous question from a new session, with the given X-Forwarded-For. */
async function ask(app: TestClient, xff: string): Promise<Response> {
  const res = await app.post('/api/v1/chat', { message: 'hi' }, { 'X-Session-ID': randomUUID(), 'X-Forwarded-For': xff })
  if (res.status === 200) await res.text()
  return res
}

describe('ANON_GLOBAL_DAILY_LIMIT', () => {
  it('caps anonymous questions from all IPs together', async () => {
    const logs = captureLogs()
    const app = await appWith({ ANON_GLOBAL_DAILY_LIMIT: '3' })
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      expect((await ask(app, ip)).status).toBe(200)
    }
    const res = await ask(app, '203.0.113.4')
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get('Retry-After'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(await res.json()).toEqual({
      error: 'Daily limit reached',
      code: 'daily_limit',
      scope: 'global',
      message: "Cora has reached today's limit for guest questions. Sign in to get 10 questions per day.",
      retryAfter,
      limitReached: true,
    })
    expect(await globalAnonUsageToday()).toBe(3)
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'chat_limit_reached', scope: 'global' }))
  })

  it('does not apply to signed-in users', async () => {
    const app = await appWith({ ANON_GLOBAL_DAILY_LIMIT: '1' })
    expect((await ask(app, '203.0.113.1')).status).toBe(200)
    expect((await ask(app, '203.0.113.2')).status).toBe(429)
    const res = await app.post('/api/v1/chat', { message: 'hi' }, bearer(await accessToken('fb-user-1')))
    expect(res.status).toBe(200)
    await res.text()
  })

  it('is off when set to 0', async () => {
    const app = await appWith({ ANON_GLOBAL_DAILY_LIMIT: '0' })
    expect((await ask(app, '203.0.113.1')).status).toBe(200)
    expect((await db.select().from(chat_usage)).map(r => r.identity_type).sort()).toEqual(['anon', 'ip'])
  })
})

describe('SIGNED_IN_GLOBAL_DAILY_LIMIT', () => {
  const SIGNED_IN_TOTAL = 'global:signed_in'

  /** Asks one question as the given signed-in user. */
  async function askAs(app: TestClient, uid: string): Promise<Response> {
    const res = await app.post('/api/v1/chat', { message: 'hi' }, bearer(await accessToken(uid)))
    if (res.status === 200) await res.text()
    return res
  }

  it('caps signed-in questions from all users together', async () => {
    const logs = captureLogs()
    const app = await appWith({ SIGNED_IN_GLOBAL_DAILY_LIMIT: '2' })
    expect((await askAs(app, 'user-a')).status).toBe(200)
    expect((await askAs(app, 'user-b')).status).toBe(200)

    const res = await askAs(app, 'user-c')
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({
      error: 'Daily limit reached',
      code: 'daily_limit',
      scope: 'signed_in_global',
      message: "Cora has reached today's limit for questions. Please try again after midnight UTC.",
      retryAfter: expect.any(Number),
      limitReached: true,
    })
    expect(await chatUsageToday('user-c')).toBe(0) // refused questions leave no trace
    expect(await chatUsageToday(SIGNED_IN_TOTAL)).toBe(2)
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'chat_limit_reached', scope: 'signed_in_global' }))
  })

  it('is separate from the anonymous total, in both directions', async () => {
    const app = await appWith({ SIGNED_IN_GLOBAL_DAILY_LIMIT: '1', ANON_GLOBAL_DAILY_LIMIT: '1' })
    expect((await askAs(app, 'user-a')).status).toBe(200)
    expect((await askAs(app, 'user-b')).status).toBe(429)
    expect((await ask(app, '203.0.113.1')).status).toBe(200) // anonymous still has its own
    expect((await ask(app, '203.0.113.2')).status).toBe(429)
    expect(await globalAnonUsageToday()).toBe(1)
    expect(await chatUsageToday(SIGNED_IN_TOTAL)).toBe(1)
  })

  it('gives the question back on both counters when Gemini fails before answering', async () => {
    const app = await appWith({})
    failWith(new Error('Gemini unavailable'))
    expect((await askAs(app, 'user-a')).status).toBe(200) // the failure arrives as an SSE error event
    expect(await chatUsageToday('user-a')).toBe(0)
    expect(await chatUsageToday(SIGNED_IN_TOTAL)).toBe(0)
  })

  it('is off when set to 0', async () => {
    const app = await appWith({ SIGNED_IN_GLOBAL_DAILY_LIMIT: '0' })
    expect((await askAs(app, 'user-a')).status).toBe(200)
    expect((await db.select().from(chat_usage)).map(r => r.identity)).toEqual(['user-a'])
  })

  it('defaults to 1000', async () => {
    const app = await appWith({})
    await setTotal(SIGNED_IN_TOTAL, 999)
    expect((await askAs(app, 'user-a')).status).toBe(200)
    expect((await askAs(app, 'user-b')).status).toBe(429)
  })
})

describe('ANON_IP_DAILY_LIMIT', () => {
  it('sets the per-IP cap', async () => {
    const app = await appWith({ ANON_IP_DAILY_LIMIT: '2' })
    expect((await ask(app, '203.0.113.1')).status).toBe(200)
    expect((await ask(app, '203.0.113.1')).status).toBe(200)
    expect((await ask(app, '203.0.113.1')).status).toBe(429)
    expect((await ask(app, '203.0.113.2')).status).toBe(200)
  })

  it('is off when set to 0: session rotation is then limited only by the global cap', async () => {
    const app = await appWith({ ANON_IP_DAILY_LIMIT: '0' })
    for (let i = 0; i < 25; i++) expect((await ask(app, '203.0.113.1')).status).toBe(200)
    expect(generateContentStream).toHaveBeenCalledTimes(25)
    expect((await db.select().from(chat_usage)).some(r => r.identity_type === 'ip')).toBe(false)
  })
})

describe('TRUST_PROXY_HOPS', () => {
  it('2 (load balancer in front of Cloud Run): uses the entry before the load balancer', async () => {
    const app = await appWith({ TRUST_PROXY_HOPS: '2', ANON_IP_DAILY_LIMIT: '2' })
    const LB = '198.51.100.250'
    expect((await ask(app, `192.0.2.101, 203.0.113.1, ${LB}`)).status).toBe(200)
    expect((await ask(app, `192.0.2.102, 203.0.113.1, ${LB}`)).status).toBe(200)
    expect((await ask(app, `192.0.2.103, 203.0.113.1, ${LB}`)).status).toBe(429) // spoofed entries don't help
    expect((await ask(app, `203.0.113.2, ${LB}`)).status).toBe(200) // another visitor
  })

  it('0 on Cloud Run is the shared-IP misconfiguration: every visitor counts as the proxy', async () => {
    const app = await appWith({ TRUST_PROXY_HOPS: '0', ANON_IP_DAILY_LIMIT: '2' })
    expect((await ask(app, '203.0.113.1')).status).toBe(200)
    expect((await ask(app, '203.0.113.2')).status).toBe(200)
    expect((await ask(app, '203.0.113.3')).status).toBe(429)
  })
})

describe('CHAT_MODE (emergency switch)', () => {
  const OFF = {
    error: 'Chat is unavailable',
    code: 'chat_unavailable',
    message: 'Cora is taking a break. Please try again later.',
  }
  const SIGNED_IN_ONLY = {
    error: 'Chat is unavailable for guests',
    code: 'chat_signed_in_only',
    message: 'Cora is only available to signed-in users right now. Sign in to continue.',
  }

  it('off: refuses every question with 503 before any paid work or counting', async () => {
    const app = await appWith({ CHAT_MODE: 'off' })
    const anon = await ask(app, '203.0.113.1')
    expect(anon.status).toBe(503)
    expect(await anon.json()).toEqual(OFF)
    const signedIn = await app.post('/api/v1/chat', { message: 'hi' }, bearer(await accessToken('fb-user-1')))
    expect(signedIn.status).toBe(503)
    expect(await signedIn.json()).toEqual(OFF)
    expect((await app.post('/api/v1/chat', '{not json', {})).status).toBe(503) // before the body is even parsed
    expect(generateContentStream).not.toHaveBeenCalled()
    expect(embedQuery).not.toHaveBeenCalled()
    expect(await db.select().from(chat_usage)).toEqual([])
  })

  it('signed_in_only: refuses anonymous questions with 503, answers signed-in users', async () => {
    const app = await appWith({ CHAT_MODE: 'signed_in_only' })
    const anon = await ask(app, '203.0.113.1')
    expect(anon.status).toBe(503)
    expect(await anon.json()).toEqual(SIGNED_IN_ONLY)
    expect(await db.select().from(chat_usage)).toEqual([])

    const signedIn = await app.post('/api/v1/chat', { message: 'hi' }, bearer(await accessToken('fb-user-1')))
    expect(signedIn.status).toBe(200)
    await signedIn.text()
    expect(generateContentStream).toHaveBeenCalledTimes(1)
  })

  it('signed_in_only: an invalid token falls back to anonymous, so it is refused too', async () => {
    const app = await appWith({ CHAT_MODE: 'signed_in_only' })
    const res = await app.post('/api/v1/chat', { message: 'hi' }, { ...bearer('expired-or-garbage'), 'X-Session-ID': randomUUID() })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('chat_signed_in_only')
  })

  it('logs the mode once at startup when it is not "on", and nothing per refused question', async () => {
    const logs = captureLogs()
    const app = await appWith({ CHAT_MODE: 'OFF' }) // case-insensitive
    await ask(app, '203.0.113.1')
    await ask(app, '203.0.113.2')
    expect(logs().filter(l => l.event === 'chat_mode')).toEqual([
      expect.objectContaining({ mode: 'off', severity: 'WARNING' }),
    ])
  })

  it('defaults to on, without a log line', async () => {
    const logs = captureLogs()
    const app = await appWith({})
    expect((await ask(app, '203.0.113.1')).status).toBe(200)
    expect(logs().filter(l => l.event === 'chat_mode')).toEqual([])
  })

  it('stops the app from starting with an unknown value', async () => {
    await expect(appWith({ CHAT_MODE: 'paused' }))
      .rejects.toThrow('CHAT_MODE must be one of on, signed_in_only, off, got "paused"')
  })
})

describe('invalid settings', () => {
  it.each([
    ['ANON_IP_DAILY_LIMIT', 'twenty'],
    ['ANON_GLOBAL_DAILY_LIMIT', '-1'],
    ['SIGNED_IN_GLOBAL_DAILY_LIMIT', 'lots'],
    ['TRUST_PROXY_HOPS', '1.5'],
  ])('%s=%j stops the app from starting', async (name, value) => {
    await expect(appWith({ [name]: value })).rejects.toThrow(`${name} must be a non-negative integer, got "${value}"`)
  })
})

/** Sets today's count of a total counter (identity_type 'global'). */
async function setTotal(identity: string, count: number) {
  await db.insert(chat_usage).values({ identity, identity_type: 'global', query_date: sql`CURRENT_DATE`, count })
}
