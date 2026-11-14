/**
 * Deploy-time settings for the anonymous chat limits (read once when the app
 * starts): ANON_GLOBAL_DAILY_LIMIT, ANON_IP_DAILY_LIMIT and TRUST_PROXY_HOPS.
 * Each test re-imports the app with its own settings (see docs/deployment-gcp.md).
 */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadFreshApp, type TestClient } from '../helpers/app.js'
import { accessToken, bearer } from '../helpers/auth.js'
import { db, resetDb } from '../fakes/db.js'
import { generateContentStream } from '../fakes/genai.js'
import { globalAnonUsageToday } from '../helpers/fixtures.js'
import { captureLogs } from '../helpers/logs.js'
import { chat_usage } from '../../src/db/schema.js'

beforeEach(resetDb)

async function appWith(env: Record<string, string>): Promise<TestClient> {
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
    expect(await res.json()).toEqual({
      limitReached: true,
      message: "Cora has reached today's limit for guest questions. Sign in to get 10 questions per day.",
    })
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
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

describe('invalid settings', () => {
  it.each([
    ['ANON_IP_DAILY_LIMIT', 'twenty'],
    ['ANON_GLOBAL_DAILY_LIMIT', '-1'],
    ['TRUST_PROXY_HOPS', '1.5'],
  ])('%s=%j stops the app from starting', async (name, value) => {
    await expect(appWith({ [name]: value })).rejects.toThrow(`${name} must be a non-negative integer, got "${value}"`)
  })
})
