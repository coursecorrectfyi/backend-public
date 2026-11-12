/**
 * src/api/middleware/auth.ts (requireAuth). Tested via /api/v1/saved, the
 * router that uses it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApp } from '../helpers/app.js'
import { accessToken, bearer, mintToken, refreshToken } from '../helpers/auth.js'
import { resetDb } from '../fakes/db.js'
import { insertResource, saveCourse } from '../helpers/fixtures.js'

beforeEach(resetDb)

describe('requireAuth', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const app = await loadApp()
    const res = await app.get('/api/v1/saved')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Missing or malformed Authorization header' })
  })

  it.each([
    ['Basic scheme', 'Basic dXNlcjpwYXNz'],
    ['lowercase bearer', 'bearer abc'],
    ['bare token', 'eyJhbGciOiJIUzI1NiJ9.e30.x'],
  ])('returns 401 for a malformed header (%s)', async (_label, header) => {
    const app = await loadApp()
    const res = await app.get('/api/v1/saved', { Authorization: header })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Missing or malformed Authorization header' })
  })

  it('returns 500 when JWT_SECRET is not configured', async () => {
    const app = await loadApp()
    const token = await accessToken()
    vi.stubEnv('JWT_SECRET', undefined)
    const res = await app.get('/api/v1/saved', bearer(token))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Server configuration error' })
  })

  it('returns 401 for a token signed with a different secret', async () => {
    const app = await loadApp()
    const token = await mintToken({ secret: 'some-other-secret' })
    const res = await app.get('/api/v1/saved', bearer(token))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid or expired token' })
  })

  it('returns 401 for an expired token', async () => {
    const app = await loadApp()
    const token = await mintToken({ expiresIn: -60 })
    const res = await app.get('/api/v1/saved', bearer(token))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid or expired token' })
  })

  it('returns 401 for a garbage token', async () => {
    const app = await loadApp()
    const res = await app.get('/api/v1/saved', bearer('not-a-jwt'))
    expect(res.status).toBe(401)
  })

  it('rejects a refresh token used as an access token', async () => {
    const app = await loadApp()
    const res = await app.get('/api/v1/saved', bearer(await refreshToken()))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid token type' })
  })

  it('rejects a token without a string subject', async () => {
    const app = await loadApp()
    for (const token of [await mintToken({ omit: ['sub'] }), await mintToken({ sub: 12345 })]) {
      const res = await app.get('/api/v1/saved', bearer(token))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Invalid token type' })
    }
  })

  it('accepts a valid access token and scopes the request to its subject', async () => {
    const app = await loadApp()
    const mine = await insertResource({ title: 'Mine' })
    const theirs = await insertResource({ title: 'Theirs' })
    await saveCourse('user-a', mine.id)
    await saveCourse('user-b', theirs.id)

    const res = await app.get('/api/v1/saved', bearer(await accessToken('user-a')))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((r: { title: string }) => r.title)).toEqual(['Mine'])
  })
})
