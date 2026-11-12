/**
 * src/index.ts: server startup, /health, CORS and route mounting.
 *
 * Env vars such as PORT and ALLOWED_ORIGINS are read when the module loads, so
 * tests that change them re-import the app with loadFreshApp().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApp, loadFreshApp } from './helpers/app.js'
import { serve } from './fakes/node-server.js'
import { db, resetDb } from './fakes/db.js'

beforeEach(resetDb)

describe('server startup', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('listens on port 3000 when PORT is not set', async () => {
    vi.stubEnv('PORT', undefined)
    await loadFreshApp()
    expect(serve).toHaveBeenCalledTimes(1)
    expect(serve.mock.lastCall![0].port).toBe(3000)
    expect(console.log).toHaveBeenCalledWith('Server is running on http://localhost:3000')
  })

  it('listens on the port from PORT', async () => {
    vi.stubEnv('PORT', '8080')
    await loadFreshApp()
    expect(serve.mock.lastCall![0].port).toBe(8080)
    expect(console.log).toHaveBeenCalledWith('Server is running on http://localhost:8080')
  })

  it('passes the Hono app fetch handler to the server', async () => {
    const app = await loadFreshApp()
    expect(typeof serve.mock.lastCall![0].fetch).toBe('function')
    const res = await app.get('/health')
    expect(res.status).toBe(200)
  })
})

describe('GET /health', () => {
  it('returns 200 { status: "ok" } when the database answers', async () => {
    const app = await loadApp()
    const res = await app.get('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('returns 503 when the database is unreachable', async () => {
    const app = await loadApp()
    vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.20.30.40:5432'))
    const res = await app.get('/health')
    expect(res.status).toBe(503)
    expect((await res.json()).status).toBe('error')
  })

  it('does not expose internal error details on the public health endpoint', async () => {
    const app = await loadApp()
    const secretDetail = 'password authentication failed for user "cc_prod" at 10.20.30.40'
    vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error(secretDetail))
    const res = await app.get('/health')
    const text = await res.text()
    expect(res.status).toBe(503)
    expect(text).not.toContain('cc_prod')
    expect(text).not.toContain('10.20.30.40')
    // ...but the detail is still logged server-side for debugging
    expect(console.error).toHaveBeenCalledWith(
      '[health] database check failed:', expect.objectContaining({ message: secretDetail }),
    )
  })
})

describe('CORS', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('echoes an allowed origin on normal requests', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://coursecorrect.fyi')
    const app = await loadFreshApp()
    const res = await app.get('/health', { Origin: 'https://coursecorrect.fyi' })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://coursecorrect.fyi')
  })

  it('answers preflight requests with the allowed methods, headers and max-age', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://coursecorrect.fyi')
    const app = await loadFreshApp()
    const res = await app.request('/api/v1/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://coursecorrect.fyi',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization, X-Session-ID',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://coursecorrect.fyi')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,DELETE,OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization,X-Session-ID')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400')
  })

  it('supports a comma-separated ALLOWED_ORIGINS list with surrounding spaces', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://coursecorrect.fyi , https://staging.coursecorrect.fyi')
    const app = await loadFreshApp()
    for (const origin of ['https://coursecorrect.fyi', 'https://staging.coursecorrect.fyi']) {
      const res = await app.get('/health', { Origin: origin })
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    }
  })

  it('defaults to http://localhost:3001 when ALLOWED_ORIGINS is not set', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', undefined)
    const app = await loadFreshApp()
    const res = await app.get('/health', { Origin: 'http://localhost:3001' })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001')
  })

  it('does not send Access-Control-Allow-Origin for origins that are not allowed', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://coursecorrect.fyi')
    const app = await loadFreshApp()
    const res = await app.get('/health', { Origin: 'https://evil.example' })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('still serves requests without an Origin header (server-to-server, health checks)', async () => {
    const app = await loadApp()
    const res = await app.get('/health')
    expect(res.status).toBe(200)
  })
})

describe('route mounting', () => {
  it.each([
    ['GET', '/api/v1/subjects', 200],
    ['GET', '/api/v1/resources/search', 400], // mounted; rejects missing q
    ['GET', '/api/v1/saved', 401],            // mounted; requires auth
    ['POST', '/api/v1/auth/logout', 200],
    ['POST', '/api/v1/chat', 400],            // mounted; rejects missing body
  ])('%s %s is handled by its router', async (method, path, status) => {
    const app = await loadApp()
    const res = await app.request(path, { method })
    expect(res.status).toBe(status)
  })

  it('returns 404 for unknown routes', async () => {
    const app = await loadApp()
    expect((await app.get('/api/v1/does-not-exist')).status).toBe(404)
    expect((await app.get('/')).status).toBe(404)
  })
})
