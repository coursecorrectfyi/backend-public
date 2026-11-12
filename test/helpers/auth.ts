import { sign } from 'hono/jwt'

interface TokenOptions {
  sub?: unknown
  type?: unknown
  /** Seconds from now; negative for an already-expired token. */
  expiresIn?: number
  secret?: string
  omit?: Array<'sub' | 'type' | 'exp'>
}

/** Mints a backend JWT the same way src/api/auth.ts does (HS256). */
export async function mintToken(opts: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: opts.sub ?? 'user-1',
    type: opts.type ?? 'access',
    iat: now,
    exp: now + (opts.expiresIn ?? 3600),
  }
  for (const key of opts.omit ?? []) delete payload[key]
  const secret = opts.secret ?? process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET must be set to mint test tokens')
  return sign(payload, secret)
}

export const accessToken = (uid = 'user-1') => mintToken({ sub: uid, type: 'access' })
export const refreshToken = (uid = 'user-1') => mintToken({ sub: uid, type: 'refresh' })
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
