/**
 * Warns when TRUST_PROXY_HOPS looks wrong for the traffic actually arriving
 * (docs/deployment-gcp.md §6).
 *
 * Browsers don't send X-Forwarded-For, so a normal request carries exactly
 * one entry per proxy in front of the app. Per instance, per minute, this
 * counts requests whose shape doesn't match:
 *
 *   fewer entries than TRUST_PROXY_HOPS   a proxy we count on isn't there: the
 *                                         setting is too high (anyone can fake
 *                                         their IP), or the API is being
 *                                         reached around the proxy
 *   more entries than TRUST_PROXY_HOPS    another proxy was added in front:
 *                                         the setting is too low (visitors
 *                                         share the proxy's IP)
 *   a private/loopback address is picked  the setting is too low
 *
 * Some requests always differ (clients behind a corporate proxy add entries,
 * scripts fake them), so it only warns when most requests in a window of at
 * least MIN_REQUESTS differ. One `proxy_hops_mismatch` line per window at most
 * (docs/monitoring.md, "How the once-a-minute summary lines work").
 * The private-address check is skipped with TRUST_PROXY_HOPS=0 (nothing in
 * front, e.g. local development on localhost).
 */

import type { MiddlewareHandler } from 'hono'
import { inspectChain, isNonPublicAddress, socketAddress } from '../../lib/client-ip.js'
import { registerInstanceState } from '../../lib/instance-state.js'
import { log } from '../../lib/logger.js'

const WINDOW_MS = 60_000
/** Fewer requests than this in a window is too small a sample to judge. */
export const MIN_REQUESTS = 20

export function proxyHopsCheck(options: { hops: number; now?: () => number }): MiddlewareHandler {
  const { hops } = options
  const now = options.now ?? (() => Date.now())

  let windowStart: number | null = null
  let requests = 0
  let fewer = 0
  let more = 0
  let nonPublic = 0
  const reset = () => {
    windowStart = null
    requests = fewer = more = nonPublic = 0
  }
  registerInstanceState(reset)

  const flush = () => {
    const mostly = (n: number) => n * 2 > requests
    if (requests >= MIN_REQUESTS && (mostly(fewer) || mostly(more) || mostly(nonPublic))) {
      log({
        event: 'proxy_hops_mismatch',
        trust_proxy_hops: hops,
        likely: mostly(fewer) ? 'hops_too_high_or_proxy_bypassed' : 'hops_too_low',
        requests,
        fewer_entries: fewer,
        more_entries: more,
        non_public_address: nonPublic,
        window_start: new Date(windowStart!).toISOString(),
      }, 'warn')
    }
    reset()
  }

  return async (c, next) => {
    if (windowStart !== null && now() - windowStart >= WINDOW_MS) flush()
    windowStart ??= now()

    const { forwardedCount, picked } = inspectChain(c.req.header('X-Forwarded-For'), socketAddress(c), hops)
    requests += 1
    if (forwardedCount < hops) fewer += 1
    if (forwardedCount > hops) more += 1
    if (hops > 0 && picked !== undefined && isNonPublicAddress(picked)) nonPublic += 1

    await next()
  }
}
