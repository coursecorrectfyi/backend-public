import { Hono } from 'hono'
import { sign, verify } from 'hono/jwt'
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { log } from '../lib/logger.js'
import { checkSignIn, providerName, readAllowedProviders } from './auth-providers.js'

// ── Constants ──────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_S = 60 * 60        // 1 hour
const REFRESH_TOKEN_TTL_S = 60 * 60 * 24 * 7  // 7 days

// Read once at startup: an unknown provider id throws, so a typo stops the
// new revision from starting (see auth-providers.ts).
const ALLOWED_PROVIDERS = readAllowedProviders()

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
 * Verifies the Firebase ID token, checks the sign-in method is allowed
 * (auth-providers.ts), upserts the user row, and returns backend JWTs.
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

  const providerId = decoded.firebase?.sign_in_provider
  const check = checkSignIn(decoded, ALLOWED_PROVIDERS)
  if (!check.allowed) {
    // No user row is created for a refused sign-in.
    log({ event: 'login_rejected', reason: check.code, provider: typeof providerId === 'string' ? providerId : null })
    return c.json({ error: check.error, code: check.code }, check.status)
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
    .returning({
      firebase_uid: users.firebase_uid,
      email: users.email,
      created_at: users.created_at,
      updated_at: users.updated_at,
      // Postgres idiom: xmax is 0 for a freshly inserted row and non-zero
      // when ON CONFLICT updated an existing one.
      isNew: sql<boolean>`(xmax = 0)`,
    })

  if (!user) return c.json({ error: 'Failed to upsert user' }, 500)

  // One line per new account, by sign-in method: watch sign-up volume per
  // provider (docs/monitoring.md). No identity is logged.
  if (user.isNew) log({ event: 'user_signed_up', provider: providerId })

  const tokens = await issueTokens(uid)

  return c.json({
    ...tokens,
    user: {
      id: user.firebase_uid,
      email: user.email,
      provider: providerName(providerId!), // checkSignIn only allows known string ids
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
