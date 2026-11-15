/**
 * src/lib/chat-usage-retention.ts and its job entry point: summarize completed
 * days into chat_usage_daily, then delete raw chat_usage rows older than the
 * retention period. Runs real SQL against PGlite.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db, resetDb } from '../fakes/db.js'
import * as dbClient from '../fakes/db.js'
import { chat_usage, chat_usage_daily } from '../../src/db/schema.js'
import {
  DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, countOf, readRetentionDays, runChatUsageRetention,
} from '../../src/lib/chat-usage-retention.js'
import { main } from '../../src/jobs/chat-usage-retention.js'
import { captureLogs, errorLogs } from '../helpers/logs.js'

beforeEach(resetDb)

type IdentityType = 'user' | 'anon' | 'ip' | 'global'

/** Adds a chat_usage row `daysAgo` days before today (database date). */
async function usage(identity: string, identityType: IdentityType, daysAgo: number, count: number) {
  await db.insert(chat_usage).values({
    identity, identity_type: identityType, query_date: sql`CURRENT_DATE - ${daysAgo}::int`, count,
  })
}

/** Days-ago of the remaining raw rows, sorted. */
async function rawDays(): Promise<number[]> {
  const rows = await db.select({ d: sql<number>`CURRENT_DATE - ${chat_usage.query_date}` }).from(chat_usage)
  return [...new Set(rows.map(r => Number(r.d)))].sort((a, b) => a - b)
}

/** The summary as { "<daysAgo>:<type>": [identities, questions] }. */
async function summary(): Promise<Record<string, [number, number]>> {
  const rows = await db
    .select({
      d: sql<number>`CURRENT_DATE - ${chat_usage_daily.query_date}`,
      type: chat_usage_daily.identity_type,
      identities: chat_usage_daily.identities,
      questions: chat_usage_daily.questions,
    })
    .from(chat_usage_daily)
  return Object.fromEntries(rows.map(r => [`${Number(r.d)}:${r.type}`, [r.identities, r.questions]]))
}

describe('settings', () => {
  it('keeps 7 days by default and never fewer than 2', () => {
    vi.stubEnv('CHAT_USAGE_RETENTION_DAYS', undefined)
    expect([DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS]).toEqual([7, 2])
    expect(readRetentionDays()).toBe(7)
    vi.stubEnv('CHAT_USAGE_RETENTION_DAYS', '30')
    expect(readRetentionDays()).toBe(30)
  })

  it.each([['1', 'at least 2'], ['0', 'at least 2'], ['week', 'non-negative integer']])(
    'rejects CHAT_USAGE_RETENTION_DAYS=%j', (value, message) => {
      vi.stubEnv('CHAT_USAGE_RETENTION_DAYS', value)
      expect(() => readRetentionDays()).toThrow(message)
    },
  )

  it('refuses to run with a retention that would break the daily limits', async () => {
    await expect(runChatUsageRetention(1)).rejects.toThrow('at least 2')
    await expect(runChatUsageRetention(2.5)).rejects.toThrow('at least 2')
  })
})

describe('runChatUsageRetention', () => {
  it('summarizes each completed day per identity type, as counts only', async () => {
    await usage('fb-1', 'user', 1, 3)
    await usage('fb-2', 'user', 1, 10)
    await usage('session-a', 'anon', 1, 5)
    await usage('session-b', 'anon', 1, 0) // every question given back: didn't ask anything
    await usage('ip:hash-1', 'ip', 1, 5)
    await usage('global:anon', 'global', 1, 5) // totals of the same questions: left out
    await usage('fb-1', 'user', 0, 2) // today: still counting, not summarized yet

    await runChatUsageRetention(7)
    expect(await summary()).toEqual({
      '1:user': [2, 13],
      '1:anon': [1, 5],
      '1:ip': [1, 5],
    })
    const stored = JSON.stringify(await db.select().from(chat_usage_daily))
    expect(stored).not.toMatch(/fb-|session-|hash/)
  })

  it('deletes raw rows older than the retention period, keeping today and the days before it', async () => {
    for (const daysAgo of [0, 1, 2, 7, 8, 30]) await usage(`fb-${daysAgo}`, 'user', daysAgo, 1)
    const result = await runChatUsageRetention(7)
    expect(await rawDays()).toEqual([0, 1, 2, 7])
    expect(result).toEqual({ summaryRows: 5, deletedRows: 2 }) // days 1, 2, 7, 8, 30 summarized; 8 and 30 deleted
  })

  it('on a first run over a long history, summarizes every completed day and keeps only the last 7 raw', async () => {
    // Two users and a session most days, over 30 days; the numbers make each day's totals distinct.
    for (let daysAgo = 0; daysAgo <= 30; daysAgo++) {
      await usage(`fb-a-${daysAgo}`, 'user', daysAgo, daysAgo + 1)
      if (daysAgo % 2 === 0) await usage(`fb-b-${daysAgo}`, 'user', daysAgo, 1)
      await usage(`session-${daysAgo}`, 'anon', daysAgo, 2)
      await usage(`ip:h-${daysAgo}`, 'ip', daysAgo, 2)
      await usage('global:anon', 'global', daysAgo, 2)
    }
    const result = await runChatUsageRetention(7)
    const totals = await summary()
    for (let daysAgo = 1; daysAgo <= 30; daysAgo++) {
      const users = daysAgo % 2 === 0 ? 2 : 1
      expect(totals[`${daysAgo}:user`]).toEqual([users, daysAgo + 1 + (users - 1)])
      expect(totals[`${daysAgo}:anon`]).toEqual([1, 2])
      expect(totals[`${daysAgo}:ip`]).toEqual([1, 2])
    }
    expect(Object.keys(totals)).toHaveLength(30 * 3) // nothing for today, nothing for 'global'
    expect(await rawDays()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(result.summaryRows).toBe(90)
  })

  it('deletes old rows of every identity type, including the totals', async () => {
    for (const type of ['user', 'anon', 'ip', 'global'] as const) {
      await usage(`${type}-old`, type, 8, 1)
      await usage(`${type}-kept`, type, 7, 1)
    }
    await runChatUsageRetention(7)
    const left = (await db.select({ identity: chat_usage.identity }).from(chat_usage)).map(r => r.identity).sort()
    expect(left).toEqual(['anon-kept', 'global-kept', 'ip-kept', 'user-kept'])
  })

  it('uses the retention period it is given: 2 keeps today, yesterday and the day before', async () => {
    for (const daysAgo of [0, 1, 2, 3]) await usage(`fb-${daysAgo}`, 'user', daysAgo, 1)
    await runChatUsageRetention(2)
    expect(await rawDays()).toEqual([0, 1, 2])
  })

  it('keeps the summary of days whose raw rows are already gone', async () => {
    await usage('fb-1', 'user', 10, 4)
    await runChatUsageRetention(7)
    expect(await rawDays()).toEqual([])
    await usage('fb-2', 'user', 1, 1)
    await runChatUsageRetention(7)
    expect(await summary()).toEqual({ '10:user': [1, 4], '1:user': [1, 1] })
  })

  it('gives the same result when run twice (e.g. a retried job)', async () => {
    await usage('fb-1', 'user', 1, 2)
    await usage('fb-2', 'user', 9, 1)
    await runChatUsageRetention(7)
    const first = await summary()
    const again = await runChatUsageRetention(7)
    expect(await summary()).toEqual(first)
    expect(again.deletedRows).toBe(0)
  })

  it('updates a day whose counts changed since the last run (a late refund for yesterday)', async () => {
    await usage('fb-1', 'user', 1, 3)
    await runChatUsageRetention(7)
    await db.update(chat_usage).set({ count: 2 })
    await runChatUsageRetention(7)
    expect(await summary()).toEqual({ '1:user': [1, 2] })
  })

  it('keeps everything when nothing is old enough, and works on an empty table', async () => {
    expect(await runChatUsageRetention(7)).toEqual({ summaryRows: 0, deletedRows: 0 })
    await usage('fb-1', 'user', 0, 1)
    expect(await runChatUsageRetention(2)).toEqual({ summaryRows: 0, deletedRows: 0 })
    expect(await rawDays()).toEqual([0])
  })

  it('changes nothing if the deletion fails (one transaction)', async () => {
    await usage('fb-1', 'user', 9, 1)
    const realTransaction = db.transaction.bind(db)
    vi.spyOn(db, 'transaction').mockImplementationOnce((fn) => realTransaction(async (tx) => {
      const realExecute = tx.execute.bind(tx)
      let calls = 0
      vi.spyOn(tx, 'execute').mockImplementation(((query: Parameters<typeof realExecute>[0]) => {
        if (++calls === 2) throw new Error('disk full')
        return realExecute(query)
      }) as typeof tx.execute)
      return fn(tx)
    }) as never)
    await expect(runChatUsageRetention(7)).rejects.toThrow('disk full')
    expect(await summary()).toEqual({})
    expect(await rawDays()).toEqual([9])
  })
})

describe('countOf', () => {
  it('reads a count from both drivers: postgres.js (rows array, bigint as string) and PGlite ({ rows })', () => {
    expect(countOf([{ n: '12' }])).toBe(12) // postgres.js returns COUNT(*) (bigint) as a string
    expect(countOf({ rows: [{ n: 3 }] })).toBe(3)
  })
})

describe('job entry point', () => {
  it('runs once, logs what it did and exits 0', async () => {
    vi.stubEnv('CHAT_USAGE_RETENTION_DAYS', undefined)
    const closeDb = vi.spyOn(dbClient, 'closeDb')
    const logs = captureLogs()
    await usage('fb-1', 'user', 9, 1)
    expect(await main()).toBe(0)
    expect(logs()).toContainEqual(expect.objectContaining({
      event: 'chat_usage_retention', retention_days: 7, summary_rows: 1, deleted_rows: 1,
    }))
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('reads the retention period from CHAT_USAGE_RETENTION_DAYS', async () => {
    vi.stubEnv('CHAT_USAGE_RETENTION_DAYS', '3')
    const logs = captureLogs()
    for (const daysAgo of [3, 4]) await usage(`fb-${daysAgo}`, 'user', daysAgo, 1)
    expect(await main()).toBe(0)
    expect(await rawDays()).toEqual([3])
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'chat_usage_retention', retention_days: 3, deleted_rows: 1 }))
  })

  it('logs a structured error and exits 1 on failure (so the execution is marked failed)', async () => {
    vi.stubEnv('CHAT_USAGE_RETENTION_DAYS', '1')
    const closeDb = vi.spyOn(dbClient, 'closeDb')
    const logs = captureLogs()
    expect(await main()).toBe(1)
    expect(errorLogs(logs(), 'chat_usage_retention_failed')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('at least 2') }),
    ])
    expect(closeDb).toHaveBeenCalledTimes(1)
  })
})

describe('job as a real process (as Cloud Run runs it)', () => {
  // Runs src/jobs/chat-usage-retention.ts in its own Node process: no test fakes, the real
  // postgres.js client and the "run when executed directly" entry code. There is no Postgres
  // server in the test environment, so this covers the failure path: a database that can't be
  // reached must give one structured error line and exit code 1. The success path is covered
  // above against PGlite.
  const job = fileURLToPath(new URL('../../src/jobs/chat-usage-retention.ts', import.meta.url))
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', job], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })

  it('exits 1 with one structured error when the database is unreachable', () => {
    const result = run({ DATABASE_URL: 'postgresql://user:pw@127.0.0.1:1/none', CHAT_USAGE_RETENTION_DAYS: '7' })
    expect(result.status).toBe(1)
    const lines = result.stdout.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toEqual([expect.objectContaining({
      severity: 'ERROR', event: 'chat_usage_retention_failed', message: expect.stringContaining('ECONNREFUSED'),
    })])
  })

  it('exits 1 before touching the database when the setting is invalid', () => {
    const result = run({ DATABASE_URL: 'postgresql://user:pw@127.0.0.1:1/none', CHAT_USAGE_RETENTION_DAYS: '1' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('at least 2')
    expect(result.stdout).not.toContain('ECONNREFUSED')
  })
})
