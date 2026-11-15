/**
 * Works out once per request who the request is counted as (the visitor a
 * trusted relay names, or the connection's client; see src/lib/relay.ts) and
 * stores it as c.var.client for the rate limiter and the chat limits.
 *
 * Relay problems are reported as one `relay_auth_failed` line per instance per
 * minute at most, with counts per problem, never the secret or an address
 * (how the windows work, and their limits: docs/monitoring.md, "How the
 * once-a-minute summary lines work").
 * They mean visitors are being counted together, so the line is in the
 * monitoring alert (docs/monitoring.md §5).
 */

import type { MiddlewareHandler } from 'hono'
import { socketAddress } from '../../lib/client-ip.js'
import { registerInstanceState } from '../../lib/instance-state.js'
import { log } from '../../lib/logger.js'
import {
  RELAY_SECRET_HEADER, VISITOR_IP_HEADER, identifyClient, type ClientIdentity, type RelayProblem, type RelaySecrets,
} from '../../lib/relay.js'

declare module 'hono' {
  interface ContextVariableMap {
    client: ClientIdentity
  }
}

const WINDOW_MS = 60_000

export function clientIdentity(options: {
  hops: number
  relays: RelaySecrets
  now?: () => number
}): MiddlewareHandler {
  const now = options.now ?? (() => Date.now())
  let windowStart: number | null = null
  let problems: Partial<Record<RelayProblem, number>> = {}
  const reset = () => {
    windowStart = null
    problems = {}
  }
  registerInstanceState(reset)

  const flushIfDue = () => {
    if (windowStart === null || now() - windowStart < WINDOW_MS) return
    log({ event: 'relay_auth_failed', ...problems, window_start: new Date(windowStart).toISOString() }, 'warn')
    reset()
  }

  return async (c, next) => {
    flushIfDue()
    const identity = identifyClient({
      relaySecret: c.req.header(RELAY_SECRET_HEADER),
      visitorIp: c.req.header(VISITOR_IP_HEADER),
      forwardedFor: c.req.header('X-Forwarded-For'),
      socketAddress: socketAddress(c),
    }, options.hops, options.relays)

    if (identity.relayProblem) {
      windowStart ??= now()
      problems[identity.relayProblem] = (problems[identity.relayProblem] ?? 0) + 1
    }
    c.set('client', identity)
    await next()
  }
}
