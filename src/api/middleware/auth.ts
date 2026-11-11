import { createMiddleware } from 'hono/factory'
import { verify } from 'hono/jwt'

declare module 'hono' {
  interface ContextVariableMap {
    userId: string
  }
}

/**
 * Verifies the backend-issued JWT in `Authorization: Bearer <token>`.
 * Sets `c.var.userId` (Firebase UID) on success.
 * Returns 401 if the token is missing, invalid, or expired.
 */
export const requireAuth = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or malformed Authorization header' }, 401)
  }

  const secret = process.env.JWT_SECRET
  if (!secret) {
    return c.json({ error: 'Server configuration error' }, 500)
  }

  const token = header.slice(7)
  try {
    const payload = await verify(token, secret, 'HS256') as Record<string, unknown>
    if (payload['type'] !== 'access' || typeof payload['sub'] !== 'string') {
      console.error('[requireAuth] token type check failed:', { type: payload['type'], hasSub: typeof payload['sub'] })
      return c.json({ error: 'Invalid token type' }, 401)
    }
    c.set('userId', payload['sub'])
    await next()
  } catch (err) {
    console.error('[requireAuth] verify failed:', err)
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
})
