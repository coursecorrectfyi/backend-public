/**
 * src/api/middleware/body-limit.ts and how src/index.ts applies it:
 * 16 KB for every route, 512 KB for POST /api/v1/chat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { loadApp, loadFreshApp } from '../helpers/app.js'
import { resetDb } from '../fakes/db.js'
import { generateContentStream } from '../fakes/genai.js'
import { verifyIdToken } from '../fakes/firebase.js'
import { chatUsageToday } from '../helpers/fixtures.js'
import { DEFAULT_MAX_BODY_BYTES, requestBodyLimit } from '../../src/api/middleware/body-limit.js'

beforeEach(resetDb)

const KB = 1024
const SESSION_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a60'

/** A JSON object serialized to exactly `bytes` bytes: the given fields plus a `pad` string. */
function jsonOfSize(bytes: number, fields: Record<string, unknown> = {}): string {
  const base = JSON.stringify({ ...fields, pad: '' })
  return JSON.stringify({ ...fields, pad: 'x'.repeat(bytes - base.length) })
}

/** A request body the client streams without a Content-Length header (chunked upload). */
function streamed(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 1000) controller.enqueue(bytes.slice(i, i + 1000))
      controller.close()
    },
  })
}

describe('requestBodyLimit', () => {
  function miniApp() {
    const app = new Hono()
    app.use('*', requestBodyLimit({ defaultMaxBytes: 10, routes: { '/big': 20 } }))
    app.post('*', async c => c.json({ received: await c.req.text() }))
    app.get('*', c => c.json({ ok: true }))
    return app
  }
  const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
    miniApp().request(path, { method: 'POST', body, headers, duplex: 'half' } as RequestInit)

  it('passes a body at the limit through unchanged', async () => {
    const res = await post('/x', '0123456789')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: '0123456789' })
  })

  it('rejects a body one byte over the limit with a JSON 413', async () => {
    const res = await post('/x', '0123456789A')
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Request body too large', maxBytes: 10 })
  })

  it('counts bytes, not characters', async () => {
    // 'é' is 2 bytes in UTF-8: 6 characters, 12 bytes
    expect((await post('/x', 'éééééé')).status).toBe(413)
  })

  it('rejects by Content-Length without reading the body', async () => {
    let read = false
    // highWaterMark 0: pull() only runs when something reads the body
    const body = new ReadableStream({ pull() { read = true; throw new Error('body was read') } }, { highWaterMark: 0 })
    const res = await post('/x', body, { 'Content-Length': '11' })
    expect(res.status).toBe(413)
    expect(read).toBe(false)
  })

  it('rejects a streamed body without Content-Length once it passes the limit', async () => {
    const res = await post('/x', streamed('0123456789A'))
    expect(res.status).toBe(413)
  })

  it('still delivers a streamed body under the limit to the handler', async () => {
    const res = await post('/x', streamed('012345'))
    expect(await res.json()).toEqual({ received: '012345' })
  })

  it('uses the per-route limit for an exact path match only', async () => {
    expect((await post('/big', 'a'.repeat(20))).status).toBe(200)
    expect((await post('/big', 'a'.repeat(21))).status).toBe(413)
    expect(await (await post('/big', 'a'.repeat(21))).json()).toEqual({ error: 'Request body too large', maxBytes: 20 })
    expect((await post('/big/sub', 'a'.repeat(11))).status).toBe(413)
    expect((await post('/bigger', 'a'.repeat(11))).status).toBe(413)
  })

  it('works without per-route limits', async () => {
    const app = new Hono()
    app.use('*', requestBodyLimit({ defaultMaxBytes: 3 }))
    app.post('*', c => c.text('ok'))
    expect((await app.request('/x', { method: 'POST', body: 'abc' })).status).toBe(200)
    expect((await app.request('/x', { method: 'POST', body: 'abcd' })).status).toBe(413)
  })

  it('ignores requests without a body', async () => {
    const res = await miniApp().request('/x')
    expect(res.status).toBe(200)
  })
})

describe('body limits in the API', () => {
  it(`uses ${DEFAULT_MAX_BODY_BYTES / KB} KB as the default limit`, () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(16 * KB)
  })

  it('lets a 16 KB login body reach the handler', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/auth/firebase/login', jsonOfSize(16 * KB, { idToken: 'forged' }))
    expect(res.status).toBe(401) // reached Firebase verification
    expect(verifyIdToken).toHaveBeenCalledWith('forged')
  })

  it('rejects a larger login body with 413 before it is parsed', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/auth/firebase/login', jsonOfSize(16 * KB + 1, { idToken: 'forged' }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Request body too large', maxBytes: 16 * KB })
    expect(verifyIdToken).not.toHaveBeenCalled()
  })

  it('rejects a 20 MB body', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/auth/firebase/login', { idToken: 'a'.repeat(20_000_000) })
    expect(res.status).toBe(413)
  })

  it('applies the default limit to routes without an override, e.g. saved courses', async () => {
    const app = await loadApp()
    const res = await app.request('/api/v1/saved/00000000-0000-4000-8000-000000000000', {
      method: 'POST', body: 'x'.repeat(16 * KB + 1),
    })
    expect(res.status).toBe(413)
  })

  it('accepts a 512 KB chat body', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/chat', jsonOfSize(512 * KB, { message: 'hi' }), { 'X-Session-ID': SESSION_ID })
    expect(res.status).toBe(200)
    await res.text()
    expect(generateContentStream).toHaveBeenCalledTimes(1)
  })

  it('rejects a larger chat body with 413, without counting it or calling Gemini', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/chat', jsonOfSize(512 * KB + 1, { message: 'hi' }), { 'X-Session-ID': SESSION_ID })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Request body too large', maxBytes: 512 * KB })
    expect(await chatUsageToday(SESSION_ID)).toBe(0)
    expect(generateContentStream).not.toHaveBeenCalled()
  })

  it('rejects an oversized chat body by Content-Length', async () => {
    const app = await loadApp()
    const body = jsonOfSize(512 * KB + 1, { message: 'hi' })
    const res = await app.post('/api/v1/chat', body, { 'X-Session-ID': SESSION_ID, 'Content-Length': String(body.length) })
    expect(res.status).toBe(413)
  })

  it('sends CORS headers with a 413, so the frontend can read the error', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://coursecorrect.fyi')
    const app = await loadFreshApp()
    const res = await app.post('/api/v1/chat', jsonOfSize(512 * KB + 1, { message: 'hi' }), {
      'X-Session-ID': SESSION_ID, Origin: 'https://coursecorrect.fyi',
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://coursecorrect.fyi')
  })
})
