/**
 * The one `429 Too Many Requests` contract (docs/api.md, "429 responses").
 *
 * Every 429 carries a `Retry-After` header (exposed to frontend code through
 * CORS in src/index.ts) and a JSON body:
 *
 *   error         short description, like every other error
 *   code          "rate_limited": too many requests per minute; retry shortly
 *                 "daily_limit":  a daily chat limit was reached; retry tomorrow
 *   message       text to show the user
 *   retryAfter    same as the Retry-After header, in seconds
 *   limitReached  true only for daily limits. Kept for the current frontend,
 *                 which treats a chat 429 with limitReached as "out of
 *                 questions for today"
 *   scope         daily limits only: which limit (user, session, ip, global)
 */

import type { Context } from 'hono'
import type { LimitScope } from './chat-usage.js'

export const RATE_LIMITED_MESSAGE = 'Too many requests. Please wait a moment and try again.'

export function rateLimitedResponse(c: Context, retryAfter: number) {
  c.header('Retry-After', String(retryAfter))
  return c.json({
    error: 'Too many requests',
    code: 'rate_limited',
    message: RATE_LIMITED_MESSAGE,
    retryAfter,
    limitReached: false,
  }, 429)
}

export function dailyLimitResponse(c: Context, scope: LimitScope, message: string, retryAfter: number) {
  c.header('Retry-After', String(retryAfter))
  return c.json({
    error: 'Daily limit reached',
    code: 'daily_limit',
    scope,
    message,
    retryAfter,
    limitReached: true,
  }, 429)
}
