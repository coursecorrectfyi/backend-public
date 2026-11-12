import { Hono } from 'hono'
import { sign, verify } from 'hono/jwt'
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'

// ── Constants ──────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_S = 60 * 60        // 1 hour
const REFRESH_TOKEN_TTL_S = 60 * 60 * 24 * 7  // 7 days

// ── Helpers ────────────────────────────────────────────────────────────────────

function jwtSecret(): string {
  const s = process.env.JWT_SECRET
  if (!s) throw new Error('JWT_SECRET env var is not set')
  return s
}

function getFirebaseApp() {
  if (getApps().length > 0) return getApps()[0]!
  return initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'your-gcp-project-id',
  })
}

async function issueTokens(uid: string): Promise<{ token: string; refreshToken: string; tokenExpires: number }> {
  const now = Math.floor(Date.now() / 1000)
  const secret = jwtSecret()

  const [token, refreshToken] = await Promise.all([
    sign({ sub: uid, type: 'access',  iat: now, exp: now + ACCESS_TOKEN_TTL_S  }, secret),
    sign({ sub: uid, type: 'refresh', iat: now, exp: now + REFRESH_TOKEN_TTL_S }, secret),
  ])

  // tokenExpires in milliseconds — matches frontend expectation
  return { token, refreshToken, tokenExpires: (now + ACCESS_TOKEN_TTL_S) * 1000 }
}

// ── Router ─────────────────────────────────────────────────────────────────────

export const authRouter = new Hono()

/**
 * POST /api/v1/auth/firebase/login
 * Body: { idToken: string }
 * Verifies the Firebase ID token, upserts the user row, and returns backend JWTs.
 */
authRouter.post('/firebase/login', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const idToken = body['idToken']
  if (typeof idToken !== 'string' || !idToken) {
    return c.json({ error: 'idToken is required' }, 400)
  }

  let decoded: Awaited<ReturnType<ReturnType<typeof getAuth>['verifyIdToken']>>
  try {
    decoded = await getAuth(getFirebaseApp()).verifyIdToken(idToken)
  } catch {
    return c.json({ error: 'Invalid Firebase ID token' }, 401)
  }

  const uid = decoded.uid
  const email = decoded.email ?? null

  // Split display name into first / last (best-effort)
  const parts = ((decoded['name'] as string | undefined) ?? '').trim().split(/\s+/)
  const firstName = parts[0] || null
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null

  const [user] = await db
    .insert(users)
    .values({ firebase_uid: uid, email })
    .onConflictDoUpdate({
      target: users.firebase_uid,
      set: { email, updated_at: new Date() },
    })
    .returning()

  if (!user) return c.json({ error: 'Failed to upsert user' }, 500)

  const tokens = await issueTokens(uid)

  return c.json({
    ...tokens,
    user: {
      id: user.firebase_uid,
      email: user.email,
      provider: 'google',
      socialId: uid,
      firstName,
      lastName,
      role:   { id: 1 },
      status: { id: 1 },
      createdAt:  user.created_at.toISOString(),
      updatedAt:  user.updated_at.toISOString(),
    },
  })
})

/**
 * POST /api/v1/auth/refresh
 * Header: Authorization: Bearer <refreshToken>
 * Issues a fresh access + refresh token pair.
 */
authRouter.post('/refresh', async (c) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing Authorization header' }, 401)
  }

  // Check config outside the try below: a missing secret must return 500,
  // not a 401 that would sign the user out.
  const secret = process.env.JWT_SECRET
  if (!secret) {
    return c.json({ error: 'Server configuration error' }, 500)
  }

  const incomingToken = header.slice(7)
  let payload: Record<string, unknown>
  try {
    payload = await verify(incomingToken, secret, 'HS256') as Record<string, unknown>
  } catch {
    return c.json({ error: 'Invalid or expired refresh token' }, 401)
  }

  if (payload['type'] !== 'refresh' || typeof payload['sub'] !== 'string') {
    return c.json({ error: 'Invalid token type' }, 401)
  }

  const { token, refreshToken, tokenExpires } = await issueTokens(payload['sub'])
  return c.json({ token, refreshToken, tokenExpires })
})

/**
 * POST /api/v1/auth/logout
 * Header: Authorization: Bearer <accessToken>
 * Stateless JWTs — tokens are discarded client-side. This endpoint exists for
 * the frontend's NextAuth signOut hook.
 */
authRouter.post('/logout', async (c) => {
  return c.json({ ok: true })
})
