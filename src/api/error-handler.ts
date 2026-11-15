import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logError } from '../lib/logger.js'

/**
 * The app's error handler (app.onError in src/index.ts) for anything a route
 * or middleware didn't handle itself.
 *
 * Logs it once, structured, for Error Reporting (docs/monitoring.md §6), and
 * answers in JSON like every other error, without details (docs/api.md). The
 * route pattern (e.g. /api/v1/saved/:resourceId) is logged rather than the
 * path, so no ids or query strings (search terms) end up in the error log.
 * An HTTPException keeps the response it carries (Hono's convention, e.g. for
 * its built-in middleware).
 */
export const handleError: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  logError('unhandled_error', err, { method: c.req.method, route: c.req.routePath })
  return c.json({ error: 'Internal server error' }, 500)
}
