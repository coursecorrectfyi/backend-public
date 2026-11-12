/** src/api/auth.ts: Firebase login, token refresh, logout. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verify } from 'hono/jwt'
import { loadApp } from '../helpers/app.js'
import { accessToken, bearer, mintToken, refreshToken } from '../helpers/auth.js'
import { resetDb } from '../fakes/db.js'
import { allUsers } from '../helpers/fixtures.js'
import { applicationDefault, initializeApp, registerIdToken, verifyIdToken } from '../fakes/firebase.js'

beforeEach(resetDb)

const LOGIN = '/api/v1/auth/firebase/login'

async function decode(token: string) {
  return (await verify(token, process.env.JWT_SECRET!, 'HS256')) as Record<string, unknown>
}

describe('POST /api/v1/auth/firebase/login', () => {
  it.each([
    ['no body', undefined],
    ['invalid JSON', '{not json'],
    ['missing idToken', {}],
    ['empty idToken', { idToken: '' }],
    ['non-string idToken', { idToken: 123 }],
  ])('returns 400 for %s', async (_label, body) => {
    const app = await loadApp()
    const res = await app.post(LOGIN, body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'idToken is required' })
    expect(verifyIdToken).not.toHaveBeenCalled()
  })

  it('returns 401 when Firebase rejects the ID token, without creating a user', async () => {
    const app = await loadApp()
    const res = await app.post(LOGIN, { idToken: 'forged' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid Firebase ID token' })
    expect(await allUsers()).toHaveLength(0)
  })

  it('creates the user and returns backend tokens plus the user profile', async () => {
    const app = await loadApp()
    registerIdToken('good-token', { uid: 'fb-uid-1', email: 'ada@example.com', name: 'Ada Lovelace' })

    const before = Date.now()
    const res = await app.post(LOGIN, { idToken: 'good-token' })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(verifyIdToken).toHaveBeenCalledWith('good-token')
    expect(body.user).toMatchObject({
      id: 'fb-uid-1',
      email: 'ada@example.com',
      provider: 'google',
      socialId: 'fb-uid-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: { id: 1 },
      status: { id: 1 },
    })
    expect(new Date(body.user.createdAt).toISOString()).toBe(body.user.createdAt)

    const access = await decode(body.token)
    const refresh = await decode(body.refreshToken)
    expect(access).toMatchObject({ sub: 'fb-uid-1', type: 'access' })
    expect(refresh).toMatchObject({ sub: 'fb-uid-1', type: 'refresh' })
    expect((access.exp as number) - (access.iat as number)).toBe(60 * 60)
    expect((refresh.exp as number) - (refresh.iat as number)).toBe(60 * 60 * 24 * 7)

    // tokenExpires is in milliseconds (frontend contract) and matches the access token
    expect(body.tokenExpires).toBe((access.exp as number) * 1000)
    expect(body.tokenExpires).toBeGreaterThan(before)

    const users = await allUsers()
    expect(users).toEqual([expect.objectContaining({ firebase_uid: 'fb-uid-1', email: 'ada@example.com' })])
  })

  it('issues an access token that works on protected routes', async () => {
    const app = await loadApp()
    registerIdToken('good-token', { uid: 'fb-uid-1', email: 'a@example.com' })
    const { token } = await (await app.post(LOGIN, { idToken: 'good-token' })).json()
    const res = await app.get('/api/v1/saved', bearer(token))
    expect(res.status).toBe(200)
  })

  it('updates the email on repeat login without creating a duplicate user', async () => {
    const app = await loadApp()
    registerIdToken('t1', { uid: 'fb-uid-1', email: 'old@example.com' })
    registerIdToken('t2', { uid: 'fb-uid-1', email: 'new@example.com' })

    const first = await (await app.post(LOGIN, { idToken: 't1' })).json()
    const second = await (await app.post(LOGIN, { idToken: 't2' })).json()

    const users = await allUsers()
    expect(users).toHaveLength(1)
    expect(users[0]!.email).toBe('new@example.com')
    expect(second.user.email).toBe('new@example.com')
    expect(second.user.createdAt).toBe(first.user.createdAt)
    expect(new Date(second.user.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.user.updatedAt).getTime())
  })

  it.each([
    ['single name', 'Plato', 'Plato', null],
    ['multi-part last name', 'Juan Pablo de la Cruz', 'Juan', 'Pablo de la Cruz'],
    ['extra whitespace', '  Grace   Hopper  ', 'Grace', 'Hopper'],
    ['no name claim', undefined, null, null],
    ['blank name', '   ', null, null],
  ])('splits the display name (%s)', async (_label, name, firstName, lastName) => {
    const app = await loadApp()
    registerIdToken('tok', { uid: 'u', email: 'u@example.com', ...(name !== undefined ? { name } : {}) })
    const body = await (await app.post(LOGIN, { idToken: 'tok' })).json()
    expect(body.user.firstName).toBe(firstName)
    expect(body.user.lastName).toBe(lastName)
  })

  it('stores a null email when the Firebase account has none (e.g. phone sign-in)', async () => {
    const app = await loadApp()
    registerIdToken('tok', { uid: 'phone-user' })
    const body = await (await app.post(LOGIN, { idToken: 'tok' })).json()
    expect(body.user.email).toBeNull()
    expect((await allUsers())[0]!.email).toBeNull()
  })

  it('initializes Firebase Admin once with application default credentials', async () => {
    const app = await loadApp()
    registerIdToken('tok', { uid: 'u' })
    await app.post(LOGIN, { idToken: 'tok' })
    await app.post(LOGIN, { idToken: 'tok' })
    expect(initializeApp).toHaveBeenCalledTimes(1)
    expect(applicationDefault).toHaveBeenCalledTimes(1)
    expect(initializeApp.mock.lastCall![0]).toMatchObject({ projectId: 'test-project' })
  })

  it('returns 500 when JWT_SECRET is not configured', async () => {
    const app = await loadApp()
    registerIdToken('tok', { uid: 'u' })
    vi.stubEnv('JWT_SECRET', undefined)
    const res = await app.post(LOGIN, { idToken: 'tok' })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/v1/auth/refresh', () => {
  it('returns 401 without an Authorization header', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/auth/refresh')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Missing Authorization header' })
  })

  it('returns 401 for an invalid or expired refresh token', async () => {
    const app = await loadApp()
    for (const token of ['garbage', await mintToken({ type: 'refresh', expiresIn: -1 }), await mintToken({ type: 'refresh', secret: 'other' })]) {
      const res = await app.post('/api/v1/auth/refresh', undefined, bearer(token))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Invalid or expired refresh token' })
    }
  })

  it('rejects an access token (only refresh tokens can be exchanged)', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/auth/refresh', undefined, bearer(await accessToken()))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid token type' })
  })

  it('issues a new access + refresh token pair for the same user', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/auth/refresh', undefined, bearer(await refreshToken('fb-uid-9')))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['refreshToken', 'token', 'tokenExpires'])
    expect(await decode(body.token)).toMatchObject({ sub: 'fb-uid-9', type: 'access' })
    expect(await decode(body.refreshToken)).toMatchObject({ sub: 'fb-uid-9', type: 'refresh' })
    expect(body.tokenExpires).toBe(((await decode(body.token)).exp as number) * 1000)
  })

  it('returns 500 (not 401) when JWT_SECRET is not configured', async () => {
    // A config error must not look like an expired session: a 401 makes the
    // frontend sign every user out.
    const app = await loadApp()
    const token = await refreshToken()
    vi.stubEnv('JWT_SECRET', undefined)
    const res = await app.post('/api/v1/auth/refresh', undefined, bearer(token))
    expect(res.status).toBe(500)
  })
})

describe('POST /api/v1/auth/logout', () => {
  it('returns ok (tokens are stateless and discarded client-side)', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/auth/logout', undefined, bearer(await accessToken()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
