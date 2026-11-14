import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/**
 * Default request body limit. Enough for every JSON body the API accepts
 * except chat (a Firebase ID token is a few KB), small enough that a flood of
 * oversized bodies can't exhaust instance memory.
 */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024

/**
 * Rejects request bodies larger than the limit for the request's path with
 * `413 { error: 'Request body too large', maxBytes }`, before the body is
 * parsed. Uses Content-Length when the client sends it; otherwise counts bytes
 * as they stream in and stops reading at the limit.
 *
 * `routes` maps an exact request path to its own limit. Every other path uses
 * `defaultMaxBytes`, so new routes are covered without extra setup.
 */
export function requestBodyLimit(options: {
  defaultMaxBytes: number
  routes?: Record<string, number>
}): MiddlewareHandler {
  const limiters = new Map<number, MiddlewareHandler>()
  const limiterFor = (maxBytes: number) => {
    let limiter = limiters.get(maxBytes)
    if (!limiter) {
      limiter = bodyLimit({
        maxSize: maxBytes,
        onError: (c) => c.json({ error: 'Request body too large', maxBytes }, 413),
      })
      limiters.set(maxBytes, limiter)
    }
    return limiter
  }

  const routes = new Map(Object.entries(options.routes ?? {}))
  return (c, next) => limiterFor(routes.get(c.req.path) ?? options.defaultMaxBytes)(c, next)
}
