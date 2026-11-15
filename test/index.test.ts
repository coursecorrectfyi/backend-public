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
import { setChatUsage } from './helpers/fixtures.js'
import { captureLogs, errorLogs } from './helpers/logs.js'

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
    const logs = captureLogs()
    const app = await loadApp()
    const secretDetail = 'password authentication failed for user "cc_prod" at 10.20.30.40'
    vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error(secretDetail))
    const res = await app.get('/health')
    const text = await res.text()
    expect(res.status).toBe(503)
    expect(text).not.toContain('cc_prod')
    expect(text).not.toContain('10.20.30.40')
    // ...but the detail is still logged server-side for debugging
    expect(errorLogs(logs(), 'health_check_failed')).toEqual([
      expect.objectContaining({ message: expect.stringContaining(secretDetail) }),
    ])
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

  // Browsers hide every response header that isn't CORS-safelisted from frontend
  // code unless Access-Control-Expose-Headers lists it. The tests can't run a
  // browser, so they check the server's half: the header is sent AND exposed.
  it('exposes Retry-After to frontend code on a chat 429 from an allowed origin', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://coursecorrect.fyi')
    const app = await loadFreshApp()
    const sessionId = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a60'
    await setChatUsage(sessionId, 'anon', 5)
    const res = await app.post('/api/v1/chat', { message: 'hi' }, {
      'X-Session-ID': sessionId, Origin: 'https://coursecorrect.fyi',
    })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://coursecorrect.fyi')
    expect(res.headers.get('Access-Control-Expose-Headers')?.split(',').map(h => h.trim())).toContain('Retry-After')
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

describe('unexpected errors (app.onError)', () => {
  it('answers 500 in JSON without details, and logs one structured error with the route pattern', async () => {
    const app = await loadApp()
    const logs = captureLogs()
    const { accessToken, bearer } = await import('./helpers/auth.js')
    const resourceId = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a60'
    vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('connect ECONNREFUSED 10.20.30.40:5432') })

    const res = await app.post(`/api/v1/saved/${resourceId}`, undefined, bearer(await accessToken('fb-user-1')))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })

    const errors = errorLogs(logs(), 'unhandled_error')
    expect(errors).toEqual([expect.objectContaining({
      '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
      method: 'POST',
      route: '/api/v1/saved/:resourceId',
      message: expect.stringMatching(/^Error: connect ECONNREFUSED/),
    })])
    expect(JSON.stringify(errors)).not.toContain(resourceId)
  })

  it('does not log search terms', async () => {
    const app = await loadApp()
    const logs = captureLogs()
    vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('boom') })
    expect((await app.get('/api/v1/resources/search?q=my%20private%20question')).status).toBe(500)
    const errors = errorLogs(logs(), 'unhandled_error')
    expect(errors).toEqual([expect.objectContaining({ route: '/api/v1/resources/search' })])
    expect(JSON.stringify(errors)).not.toContain('private')
  })

  it('keeps the response of an HTTPException (Hono middleware convention), without logging an error', async () => {
    const { Hono } = await import('hono')
    const { HTTPException } = await import('hono/http-exception')
    const { handleError } = await import('../src/api/error-handler.js')
    // The app's own handler on a tiny app: no route in the API throws HTTPException today.
    const mini = new Hono()
    mini.onError(handleError)
    mini.get('/', () => { throw new HTTPException(418, { message: 'teapot' }) })
    const logs = captureLogs()
    const res = await mini.request('/')
    expect(res.status).toBe(418)
    expect(errorLogs(logs(), 'unhandled_error')).toEqual([])
  })
})
