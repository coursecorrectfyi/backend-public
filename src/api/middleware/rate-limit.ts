/**
 * Per-client, per-minute rate limits (docs/api.md "Rate limits",
 * docs/deployment-gcp.md §6).
 *
 * Requests are grouped by route, and each (group, client) pair gets its own
 * token bucket (src/lib/rate-limit.ts). The client is c.var.client, set by
 * the clientIdentity middleware: the visitor a trusted relay names, or the
 * connection's client (TRUST_PROXY_HOPS rules). Every route is limited, except
 * CORS preflights.
 *
 * Modes (RATE_LIMIT_MODE):
 *   enforce  requests over the limit get 429 rate_limited (limit-responses.ts)
 *   shadow   nothing is rejected; requests over the limit are only counted
 *            and logged, to check the budgets against real traffic first
 *
 * Logging: one `rate_limit_summary` line per instance per minute at most, not
 * one per request, so a flood can't run up the logging bill. No IPs are logged.
 */

import type { MiddlewareHandler } from 'hono'
import { readEnumEnv, readNonNegativeIntEnv } from '../../lib/env.js'
import { registerInstanceState } from '../../lib/instance-state.js'
import { log } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rate-limit.js'
import { rateLimitedResponse } from '../limit-responses.js'

export type RateLimitGroup = 'chat' | 'search' | 'login' | 'default'
export const RATE_LIMIT_MODES = ['enforce', 'shadow'] as const
export type RateLimitMode = typeof RATE_LIMIT_MODES[number]

/** Requests per client IP per minute, per group (D6). 0 turns a group off. */
export const DEFAULT_RATE_LIMITS: Record<RateLimitGroup, number> = {
  chat: 10,
  search: 60,
  login: 20,
  default: 120,
}

export const RATE_LIMIT_ENV: Record<RateLimitGroup, string> = {
  chat: 'RATE_LIMIT_CHAT_PER_MIN',
  search: 'RATE_LIMIT_SEARCH_PER_MIN',
  login: 'RATE_LIMIT_LOGIN_PER_MIN',
  default: 'RATE_LIMIT_DEFAULT_PER_MIN',
}

export interface RateLimitConfig {
  mode: RateLimitMode
  perMinute: Record<RateLimitGroup, number>
}

/** Reads RATE_LIMIT_MODE and RATE_LIMIT_*_PER_MIN. Throws on invalid values. */
export function readRateLimitConfig(): RateLimitConfig {
  const perMinute = { ...DEFAULT_RATE_LIMITS }
  for (const group of Object.keys(perMinute) as RateLimitGroup[]) {
    perMinute[group] = readNonNegativeIntEnv(RATE_LIMIT_ENV[group], DEFAULT_RATE_LIMITS[group])
  }
  return { mode: readEnumEnv('RATE_LIMIT_MODE', RATE_LIMIT_MODES, 'enforce'), perMinute }
}

/**
 * The group a request is limited under, or null if it isn't limited.
 *
 * `path` must be c.req.path: it is decoded the same way the router matches
 * routes, so a variant such as /api/v1/resources/%73earch lands in the same
 * group as the route that serves it. HEAD is treated as GET because Hono runs
 * the GET handler for it (a HEAD search still calls the embedding API).
 */
export function routeGroup(method: string, path: string): RateLimitGroup | null {
  if (method === 'OPTIONS') return null // CORS preflight, answered by the cors middleware
  const m = method === 'HEAD' ? 'GET' : method

  if (m === 'POST' && path === '/api/v1/chat') return 'chat'
  if (m === 'GET' && path === '/api/v1/resources/search') return 'search'
  if (m === 'POST' && path === '/api/v1/auth/firebase/login') return 'login'

  // Everything else: resource detail, subjects, saved courses, token refresh,
  // logout, /health, and anything unknown (404s)
  return 'default'
}

const SUMMARY_WINDOW_MS = 60_000
/** Distinct clients tracked per summary window; beyond this they are only counted in total. */
export const DEFAULT_MAX_TRACKED_CLIENTS = 10_000

/**
 * Collects requests over the limit (and requests whose IP is unknown) for up
 * to a minute, then logs one summary. The summary is written by the first
 * request after the window ends: on Cloud Run an idle instance gets little or
 * no CPU, so a timer wouldn't fire reliably anyway, and with no requests there
 * is nothing new to report. (The last window of an instance that shuts down
 * is lost: docs/monitoring.md, "How the once-a-minute summary lines work".)
 */
class OverLimitSummary {
  private windowStart: number | null = null
  private byGroup: Partial<Record<RateLimitGroup, number>> = {}
  private perClient = new Map<string, number>()
  private total = 0
  private unknownClient = 0

  constructor(
    private readonly mode: RateLimitMode,
    private readonly hops: number,
    private readonly now: () => number,
    private readonly maxTrackedClients: number,
  ) {}

  flushIfDue(): void {
    if (this.windowStart !== null && this.now() - this.windowStart >= SUMMARY_WINDOW_MS) this.flush()
  }

  recordOverLimit(group: RateLimitGroup, client: string): void {
    this.windowStart ??= this.now()
    this.total += 1
    this.byGroup[group] = (this.byGroup[group] ?? 0) + 1
    const seen = this.perClient.get(client)
    if (seen !== undefined || this.perClient.size < this.maxTrackedClients) this.perClient.set(client, (seen ?? 0) + 1)
  }

  recordUnknownClient(): void {
    this.windowStart ??= this.now()
    this.unknownClient += 1
  }

  reset(): void {
    this.windowStart = null
    this.byGroup = {}
    this.perClient.clear()
    this.total = 0
    this.unknownClient = 0
  }

  private flush(): void {
    const windowStart = new Date(this.windowStart!).toISOString()
    if (this.total > 0) {
      log({
        event: 'rate_limit_summary',
        mode: this.mode,
        // enforce: these requests got 429. shadow: they were let through.
        over_limit: this.total,
        by_group: this.byGroup,
        // How concentrated it is: one client at max_per_client ≈ over_limit is
        // a single busy IP (a script, or a shared NAT or server).
        clients: this.perClient.size,
        clients_capped: this.perClient.size >= this.maxTrackedClients,
        max_per_client: Math.max(...this.perClient.values()),
        window_start: windowStart,
      }, 'warn')
    }
    if (this.unknownClient > 0) {
      // Same event as the chat route logs: the per-IP limits were skipped.
      log({
        event: 'client_ip_unknown',
        route: 'rate_limit',
        requests: this.unknownClient,
        trust_proxy_hops: this.hops,
        window_start: windowStart,
      }, 'warn')
    }
    this.reset()
  }
}

/**
 * The rate-limit middleware. Register it after CORS (so a 429 carries CORS
 * headers and the browser lets the frontend read it) and clientIdentity, and
 * before anything that reads the body.
 */
export function rateLimit(
  config: RateLimitConfig,
  options: { hops: number; now?: () => number; maxKeys?: number; maxTrackedClients?: number },
): MiddlewareHandler {
  const now = options.now ?? (() => Date.now())
  const limiter = new RateLimiter({ now, maxKeys: options.maxKeys })
  const summary = new OverLimitSummary(
    config.mode, options.hops, now, options.maxTrackedClients ?? DEFAULT_MAX_TRACKED_CLIENTS,
  )
  registerInstanceState(() => {
    limiter.clear()
    summary.reset()
  })

  return async (c, next) => {
    summary.flushIfDue()

    const group = routeGroup(c.req.method, c.req.path)
    const perMinute = group === null ? 0 : config.perMinute[group]
    if (group === null || perMinute === 0) return next()

    const identity = c.get('client')
    if (!identity) throw new Error('rateLimit needs the clientIdentity middleware registered before it')
    const client = identity.key
    if (client === null) {
      // Can't tell clients apart: fail open rather than put everyone in one bucket.
      summary.recordUnknownClient()
      return next()
    }

    const result = limiter.take(`${group}|${client}`, perMinute)
    if (result.allowed) return next()

    summary.recordOverLimit(group, client)
    if (config.mode === 'shadow') return next()
    return rateLimitedResponse(c, result.retryAfterSeconds)
  }
}
