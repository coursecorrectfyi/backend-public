/**
 * Daily question limits for POST /api/v1/chat.
 *
 * Every question is counted against one or more counters in chat_usage:
 *
 *   signed-in user   'user'    Firebase UID                      10/day
 *                    'global'  all signed-in questions           SIGNED_IN_GLOBAL_DAILY_LIMIT (default 1000, 0 = off)
 *   anonymous        'anon'    X-Session-ID (UUID)                5/day
 *                    'ip'      all anonymous sessions from the
 *                              client's IP (IPv6: /64)           ANON_IP_DAILY_LIMIT     (default 20, 0 = off)
 *                    'global'  all anonymous questions           ANON_GLOBAL_DAILY_LIMIT (default 1000, 0 = off)
 *
 * A question is answered only if every counter is under its limit. Signed-in
 * users have no IP counter: they are authenticated, and the IP cap exists to
 * stop anonymous session-id rotation. Each group has its own total, so a flood
 * of anonymous questions can't use up signed-in users' capacity, and the
 * signed-in total is a ceiling in case accounts turn out cheap to create
 * (see docs/auth-providers.md).
 *
 * Hold, then release: a question is counted when it arrives and given back
 * (refundUsage) if Gemini fails before sending any text. Requests over a limit
 * are rejected and leave no trace in the DB.
 *
 * Checking and counting is atomic. Each counter is an upsert that only
 * increments while count < limit (Postgres locks the row while it does so),
 * and all of a question's counters are updated in one transaction that is
 * rolled back if any of them is full. Simultaneous requests therefore queue up
 * and can't slip past a limit. Counters are always taken in the same order
 * (own, ip, total), so two transactions can't deadlock.
 *
 * Limits are per UTC day: query_date is the database's CURRENT_DATE, so the
 * Cloud SQL instance must use UTC (its default).
 */

import { createHmac } from 'node:crypto'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { chat_usage, type ChatUsageIdentityType } from '../db/schema.js'
import { readNonNegativeIntEnv } from '../lib/env.js'

export const LIMIT_SIGNED_IN = 10
export const LIMIT_ANONYMOUS = 5
export const DEFAULT_ANON_IP_DAILY_LIMIT = 20
export const DEFAULT_ANON_GLOBAL_DAILY_LIMIT = 1000
export const DEFAULT_SIGNED_IN_GLOBAL_DAILY_LIMIT = 1000

/** The identity shared by all anonymous questions (the anonymous total). */
export const GLOBAL_ANON_IDENTITY = 'global:anon'
/** The identity shared by all signed-in questions (the signed-in total). */
export const GLOBAL_SIGNED_IN_IDENTITY = 'global:signed_in'

export interface ChatLimits {
  /** Anonymous questions per client IP per day, across all sessions. 0 = off. */
  ipDailyLimit: number
  /** Anonymous questions per day in total. 0 = off. */
  globalDailyLimit: number
  /** Signed-in questions per day in total. 0 = off. */
  signedInGlobalDailyLimit: number
}

/**
 * Reads ANON_IP_DAILY_LIMIT, ANON_GLOBAL_DAILY_LIMIT and
 * SIGNED_IN_GLOBAL_DAILY_LIMIT. Throws on invalid values.
 */
export function readChatLimits(): ChatLimits {
  return {
    ipDailyLimit: readNonNegativeIntEnv('ANON_IP_DAILY_LIMIT', DEFAULT_ANON_IP_DAILY_LIMIT),
    globalDailyLimit: readNonNegativeIntEnv('ANON_GLOBAL_DAILY_LIMIT', DEFAULT_ANON_GLOBAL_DAILY_LIMIT),
    signedInGlobalDailyLimit: readNonNegativeIntEnv('SIGNED_IN_GLOBAL_DAILY_LIMIT', DEFAULT_SIGNED_IN_GLOBAL_DAILY_LIMIT),
  }
}

/**
 * Which limit was reached: shown to the user as different messages.
 * 'global' is the anonymous total, 'signed_in_global' the signed-in total.
 */
export type LimitScope = 'user' | 'session' | 'ip' | 'global' | 'signed_in_global'

export interface UsageCounter {
  scope: LimitScope
  identity: string
  identityType: ChatUsageIdentityType
  limit: number
}

/**
 * The identity an IP is counted under: 'ip:' + HMAC-SHA256 of the UTC date and
 * the client key (see src/lib/client-ip.ts).
 *
 * Keyed, so the stored value can't be reversed by hashing all 4 billion IPv4
 * addresses. The key is derived from JWT_SECRET with a fixed label, so it is
 * never the JWT signing key itself and needs no extra secret. The date makes
 * the same IP unlinkable across days, even for us.
 */
export function ipIdentity(clientKey: string, utcDate: string, secret: string): string {
  const key = createHmac('sha256', secret).update('coursecorrect:chat-usage-ip:v1').digest()
  return `ip:${createHmac('sha256', key).update(`${utcDate}|${clientKey}`).digest('hex')}`
}

/** Today's date in UTC as YYYY-MM-DD. */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** Seconds until the next UTC midnight, when the daily limits reset (at least 1). */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000))
}

/**
 * The counters a question is checked against. `clientKey` is null when the
 * client's IP is unknown; the IP counter is then skipped (the caller logs it).
 */
export function usageCounters(
  who: { kind: 'user' | 'anon'; identity: string },
  clientKey: string | null,
  limits: ChatLimits,
  secret: string,
  now: Date = new Date(),
): UsageCounter[] {
  if (who.kind === 'user') {
    const counters: UsageCounter[] = [{ scope: 'user', identity: who.identity, identityType: 'user', limit: LIMIT_SIGNED_IN }]
    if (limits.signedInGlobalDailyLimit > 0) {
      counters.push({
        scope: 'signed_in_global', identity: GLOBAL_SIGNED_IN_IDENTITY, identityType: 'global',
        limit: limits.signedInGlobalDailyLimit,
      })
    }
    return counters
  }
  const counters: UsageCounter[] = [
    { scope: 'session', identity: who.identity, identityType: 'anon', limit: LIMIT_ANONYMOUS },
  ]
  if (limits.ipDailyLimit > 0 && clientKey !== null) {
    counters.push({
      scope: 'ip', identity: ipIdentity(clientKey, utcDate(now), secret), identityType: 'ip', limit: limits.ipDailyLimit,
    })
  }
  if (limits.globalDailyLimit > 0) {
    counters.push({ scope: 'global', identity: GLOBAL_ANON_IDENTITY, identityType: 'global', limit: limits.globalDailyLimit })
  }
  return counters
}

class LimitReached extends Error {
  constructor(readonly scope: LimitScope) {
    super(`chat limit reached: ${scope}`)
  }
}

export type UsageResult =
  | { allowed: true; queryDate: string; identities: string[] }
  | { allowed: false; scope: LimitScope }

/**
 * Counts one question against every counter, or against none if any of them
 * is full (the transaction is rolled back). Returns the date it was counted
 * on and the identities, for refundUsage.
 */
export async function checkAndIncrementUsage(counters: UsageCounter[]): Promise<UsageResult> {
  try {
    return await db.transaction(async (tx) => {
      let queryDate = ''
      for (const counter of counters) {
        const [counted] = await tx
          .insert(chat_usage)
          .values({
            identity: counter.identity,
            identity_type: counter.identityType,
            query_date: sql`CURRENT_DATE`,
            count: 1,
          })
          .onConflictDoUpdate({
            target: [chat_usage.identity, chat_usage.query_date],
            set: { count: sql`${chat_usage.count} + 1` },
            // Only count the question while under the limit. When this is false,
            // nothing is updated and no row comes back.
            setWhere: sql`${chat_usage.count} < ${counter.limit}`,
          })
          .returning({ queryDate: chat_usage.query_date })

        if (!counted) throw new LimitReached(counter.scope)
        // CURRENT_DATE is fixed for the whole transaction, so every row has the same date
        queryDate = counted.queryDate
      }
      return { allowed: true as const, queryDate, identities: counters.map(c => c.identity) }
    })
  } catch (err) {
    if (err instanceof LimitReached) return { allowed: false, scope: err.scope }
    throw err
  }
}

/**
 * Gives back a question that was counted but never answered (Gemini failed
 * before sending any text), on every counter it was counted against. Uses the
 * date the question was counted on, so a failure just after midnight doesn't
 * take one off the new day.
 */
export async function refundUsage(identities: string[], queryDate: string): Promise<void> {
  await db
    .update(chat_usage)
    .set({ count: sql`${chat_usage.count} - 1` })
    .where(
      and(
        inArray(chat_usage.identity, identities),
        eq(chat_usage.query_date, queryDate),
        gt(chat_usage.count, 0),
      ),
    )
}
