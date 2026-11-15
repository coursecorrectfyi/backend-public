/**
 * src/api/chat-usage.ts: daily question counters. The counting runs real SQL
 * against PGlite; chat.test.ts covers the same rules through the HTTP API.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db, resetDb } from '../fakes/db.js'
import { chatUsageToday } from '../helpers/fixtures.js'
import { chat_usage } from '../../src/db/schema.js'
import {
  DEFAULT_ANON_GLOBAL_DAILY_LIMIT, DEFAULT_ANON_IP_DAILY_LIMIT, DEFAULT_SIGNED_IN_GLOBAL_DAILY_LIMIT, GLOBAL_ANON_IDENTITY,
  GLOBAL_SIGNED_IN_IDENTITY, LIMIT_ANONYMOUS, LIMIT_SIGNED_IN,
  checkAndIncrementUsage, ipIdentity, readChatLimits, refundUsage, secondsUntilUtcMidnight, usageCounters, utcDate,
  type UsageCounter,
} from '../../src/api/chat-usage.js'

beforeEach(resetDb)

const SECRET = 'test-secret'
const SESSION_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a60'
const limits = { ipDailyLimit: 20, globalDailyLimit: 1000, signedInGlobalDailyLimit: 1000 }

describe('limits', () => {
  it('keeps the documented values', () => {
    expect([
      LIMIT_SIGNED_IN, LIMIT_ANONYMOUS, DEFAULT_ANON_IP_DAILY_LIMIT, DEFAULT_ANON_GLOBAL_DAILY_LIMIT,
      DEFAULT_SIGNED_IN_GLOBAL_DAILY_LIMIT,
    ]).toEqual([10, 5, 20, 1000, 1000])
  })

  it('reads ANON_IP_DAILY_LIMIT, ANON_GLOBAL_DAILY_LIMIT and SIGNED_IN_GLOBAL_DAILY_LIMIT, with defaults', () => {
    vi.stubEnv('ANON_IP_DAILY_LIMIT', undefined)
    vi.stubEnv('ANON_GLOBAL_DAILY_LIMIT', undefined)
    vi.stubEnv('SIGNED_IN_GLOBAL_DAILY_LIMIT', undefined)
    expect(readChatLimits()).toEqual({ ipDailyLimit: 20, globalDailyLimit: 1000, signedInGlobalDailyLimit: 1000 })
    vi.stubEnv('ANON_IP_DAILY_LIMIT', '0')
    vi.stubEnv('ANON_GLOBAL_DAILY_LIMIT', '50000')
    vi.stubEnv('SIGNED_IN_GLOBAL_DAILY_LIMIT', '7')
    expect(readChatLimits()).toEqual({ ipDailyLimit: 0, globalDailyLimit: 50000, signedInGlobalDailyLimit: 7 })
  })

  it.each(['ANON_GLOBAL_DAILY_LIMIT', 'SIGNED_IN_GLOBAL_DAILY_LIMIT'])('rejects invalid values of %s', name => {
    vi.stubEnv(name, '-5')
    expect(() => readChatLimits()).toThrow(`${name} must be a non-negative integer`)
  })
})

describe('ipIdentity', () => {
  const id = ipIdentity('203.0.113.7', '2026-01-15', SECRET)

  it('is "ip:" plus a 64-character hex HMAC, with no trace of the address', () => {
    expect(id).toMatch(/^ip:[0-9a-f]{64}$/)
    expect(id).not.toContain('203')
  })

  it('is stable for the same address, day and secret', () => {
    expect(ipIdentity('203.0.113.7', '2026-01-15', SECRET)).toBe(id)
  })

  it('differs by address, by day (unlinkable across days) and by secret', () => {
    expect(ipIdentity('203.0.113.8', '2026-01-15', SECRET)).not.toBe(id)
    expect(ipIdentity('203.0.113.7', '2026-01-16', SECRET)).not.toBe(id)
    expect(ipIdentity('203.0.113.7', '2026-01-15', 'other-secret')).not.toBe(id)
  })
})

describe('dates', () => {
  it('utcDate is the UTC calendar date', () => {
    expect(utcDate(new Date('2026-01-15T23:30:00-05:00'))).toBe('2026-01-16')
  })

  it.each([
    ['2026-01-15T00:00:00.000Z', 86_400],
    ['2026-01-15T12:00:00.000Z', 43_200],
    ['2026-01-15T23:59:59.000Z', 1],
    ['2026-01-15T23:59:59.900Z', 1], // never 0: rounds up, at least 1 second
  ])('secondsUntilUtcMidnight at %s is %d', (at, expected) => {
    expect(secondsUntilUtcMidnight(new Date(at))).toBe(expected)
  })
})

describe('usageCounters', () => {
  const now = new Date('2026-01-15T10:00:00Z')

  it('signed-in questions count against the user and the signed-in total, in that order, never the IP', () => {
    expect(usageCounters({ kind: 'user', identity: 'fb-1' }, '203.0.113.7', limits, SECRET, now)).toEqual([
      { scope: 'user', identity: 'fb-1', identityType: 'user', limit: 10 },
      { scope: 'signed_in_global', identity: GLOBAL_SIGNED_IN_IDENTITY, identityType: 'global', limit: 1000 },
    ])
  })

  it('skips the signed-in total when its limit is 0', () => {
    expect(usageCounters({ kind: 'user', identity: 'fb-1' }, null, { ...limits, signedInGlobalDailyLimit: 0 }, SECRET, now))
      .toEqual([{ scope: 'user', identity: 'fb-1', identityType: 'user', limit: 10 }])
  })

  it('keeps the anonymous and signed-in totals apart', () => {
    expect(GLOBAL_ANON_IDENTITY).not.toBe(GLOBAL_SIGNED_IN_IDENTITY)
  })

  it('anonymous questions count against the session, the IP and the global counter, in that order', () => {
    expect(usageCounters({ kind: 'anon', identity: SESSION_ID }, '203.0.113.7', limits, SECRET, now)).toEqual([
      { scope: 'session', identity: SESSION_ID, identityType: 'anon', limit: 5 },
      { scope: 'ip', identity: ipIdentity('203.0.113.7', '2026-01-15', SECRET), identityType: 'ip', limit: 20 },
      { scope: 'global', identity: GLOBAL_ANON_IDENTITY, identityType: 'global', limit: 1000 },
    ])
  })

  it('skips the IP counter when the IP is unknown or the limit is 0, and the global one when its limit is 0', () => {
    const scopes = (key: string | null, l: typeof limits) =>
      usageCounters({ kind: 'anon', identity: SESSION_ID }, key, l, SECRET, now).map(c => c.scope)
    expect(scopes(null, limits)).toEqual(['session', 'global'])
    expect(scopes('203.0.113.7', { ...limits, ipDailyLimit: 0 })).toEqual(['session', 'global'])
    expect(scopes('203.0.113.7', { ...limits, globalDailyLimit: 0 })).toEqual(['session', 'ip'])
  })
})

describe('checkAndIncrementUsage', () => {
  const counter = (scope: UsageCounter['scope'], identity: string, limit: number): UsageCounter => ({
    scope, identity, limit, identityType: scope === 'session' ? 'anon' : scope === 'user' ? 'user' : scope === 'ip' ? 'ip' : 'global',
  })
  const all = async () =>
    Object.fromEntries((await db.select().from(chat_usage)).map(r => [r.identity, r.count]))

  it('counts the question on every counter and returns the date and identities', async () => {
    const result = await checkAndIncrementUsage([counter('session', 's', 5), counter('ip', 'ip:x', 20), counter('global', 'g', 100)])
    const [{ today }] = (await db.execute<{ today: string }>(sql`SELECT CURRENT_DATE::text AS today`)).rows as [{ today: string }]
    expect(result).toEqual({ allowed: true, queryDate: today, identities: ['s', 'ip:x', 'g'] })
    expect(await all()).toEqual({ s: 1, 'ip:x': 1, g: 1 })
  })

  it('reports the first full counter and leaves no trace on the others', async () => {
    await db.insert(chat_usage).values({ identity: 'ip:x', identity_type: 'ip', query_date: sql`CURRENT_DATE`, count: 20 })
    const result = await checkAndIncrementUsage([counter('session', 's', 5), counter('ip', 'ip:x', 20), counter('global', 'g', 100)])
    expect(result).toEqual({ allowed: false, scope: 'ip' })
    expect(await all()).toEqual({ 'ip:x': 20 }) // the session row insert was rolled back
  })

  it('reports the session when both the session and the IP are full', async () => {
    await db.insert(chat_usage).values([
      { identity: 's', identity_type: 'anon', query_date: sql`CURRENT_DATE`, count: 5 },
      { identity: 'ip:x', identity_type: 'ip', query_date: sql`CURRENT_DATE`, count: 20 },
    ])
    expect(await checkAndIncrementUsage([counter('session', 's', 5), counter('ip', 'ip:x', 20)]))
      .toEqual({ allowed: false, scope: 'session' })
  })

  it('rolls back earlier increments on an existing row too', async () => {
    await db.insert(chat_usage).values([
      { identity: 's', identity_type: 'anon', query_date: sql`CURRENT_DATE`, count: 2 },
      { identity: 'g', identity_type: 'global', query_date: sql`CURRENT_DATE`, count: 100 },
    ])
    expect(await checkAndIncrementUsage([counter('session', 's', 5), counter('global', 'g', 100)]))
      .toEqual({ allowed: false, scope: 'global' })
    expect(await chatUsageToday('s')).toBe(2)
  })

  it('admits exactly the IP limit when many sessions from one IP ask at once', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      checkAndIncrementUsage([counter('session', `s${i}`, 5), counter('ip', 'ip:x', 20)])))
    expect(results.filter(r => r.allowed)).toHaveLength(20)
    expect(await chatUsageToday('ip:x')).toBe(20)
    expect((await db.select().from(chat_usage)).filter(r => r.identity_type === 'anon')).toHaveLength(20)
  })

  it('rethrows database errors', async () => {
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('connection lost'))
    await expect(checkAndIncrementUsage([counter('session', 's', 5)])).rejects.toThrow('connection lost')
  })
})

describe('refundUsage', () => {
  it('gives the question back on every counter, for that date only, never below 0', async () => {
    await db.insert(chat_usage).values([
      { identity: 's', identity_type: 'anon', query_date: sql`CURRENT_DATE`, count: 2 },
      { identity: 'ip:x', identity_type: 'ip', query_date: sql`CURRENT_DATE`, count: 0 },
      { identity: 'g', identity_type: 'global', query_date: sql`CURRENT_DATE - 1`, count: 7 },
      { identity: 'other', identity_type: 'anon', query_date: sql`CURRENT_DATE`, count: 3 },
    ])
    const [{ today }] = (await db.execute<{ today: string }>(sql`SELECT CURRENT_DATE::text AS today`)).rows as [{ today: string }]
    await refundUsage(['s', 'ip:x', 'g'], today)
    const rows = Object.fromEntries((await db.select().from(chat_usage)).map(r => [r.identity, r.count]))
    expect(rows).toEqual({ s: 1, 'ip:x': 0, g: 7, other: 3 })
  })
})
