/** src/api/saved.ts: saved courses (all routes require auth). */
import { beforeEach, describe, expect, it } from 'vitest'
import { loadApp } from '../helpers/app.js'
import { accessToken, bearer } from '../helpers/auth.js'
import { resetDb } from '../fakes/db.js'
import { insertResource, saveCourse, savedResourceIds } from '../helpers/fixtures.js'

beforeEach(resetDb)

const USER = 'fb-user-1'
const auth = async (uid = USER) => bearer(await accessToken(uid))

describe('authentication', () => {
  it.each([
    ['GET', '/api/v1/saved'],
    ['POST', '/api/v1/saved/00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/api/v1/saved/00000000-0000-4000-8000-000000000000'],
  ])('%s %s returns 401 without a token', async (method, path) => {
    const app = await loadApp()
    expect((await app.request(path, { method })).status).toBe(401)
  })
})

describe('GET /api/v1/saved', () => {
  it('returns an empty list when nothing is saved', async () => {
    const app = await loadApp()
    const res = await app.get('/api/v1/saved', await auth())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [] })
  })

  it('returns saved resources with url and saved_at, without internal fields', async () => {
    const app = await loadApp()
    const r = await insertResource({ title: 'SQL', source_url: 'https://src/sql', affiliate_url: 'https://aff/sql' })
    await saveCourse(USER, r.id, new Date('2025-03-01T12:00:00.000Z'))
    const { data } = await (await app.get('/api/v1/saved', await auth())).json()
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ id: r.id, title: 'SQL', url: 'https://aff/sql', saved_at: '2025-03-01T12:00:00.000Z' })
    expect(data[0]).not.toHaveProperty('source_url')
    expect(data[0]).not.toHaveProperty('affiliate_url')
  })

  it('orders by most recently saved first', async () => {
    const app = await loadApp()
    const oldest = await insertResource({ title: 'Oldest' })
    const newest = await insertResource({ title: 'Newest' })
    const middle = await insertResource({ title: 'Middle' })
    await saveCourse(USER, oldest.id, new Date('2024-01-01'))
    await saveCourse(USER, newest.id, new Date('2025-06-01'))
    await saveCourse(USER, middle.id, new Date('2025-01-01'))
    const { data } = await (await app.get('/api/v1/saved', await auth())).json()
    expect(data.map((r: { title: string }) => r.title)).toEqual(['Newest', 'Middle', 'Oldest'])
  })

  it('hides saved resources that have since become inactive', async () => {
    const app = await loadApp()
    const active = await insertResource({ title: 'Active' })
    const retired = await insertResource({ title: 'Retired', is_active: false })
    await saveCourse(USER, active.id)
    await saveCourse(USER, retired.id)
    const { data } = await (await app.get('/api/v1/saved', await auth())).json()
    expect(data.map((r: { title: string }) => r.title)).toEqual(['Active'])
  })

  it("only returns the caller's saved resources", async () => {
    const app = await loadApp()
    const a = await insertResource({ title: 'A' })
    const b = await insertResource({ title: 'B' })
    await saveCourse('alice', a.id)
    await saveCourse('bob', b.id)
    const { data } = await (await app.get('/api/v1/saved', await auth('alice'))).json()
    expect(data.map((r: { title: string }) => r.title)).toEqual(['A'])
  })
})

describe('POST /api/v1/saved/:resourceId', () => {
  it('saves a resource for the caller', async () => {
    const app = await loadApp()
    const r = await insertResource()
    const res = await app.post(`/api/v1/saved/${r.id}`, undefined, await auth())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await savedResourceIds(USER)).toEqual([r.id])
  })

  it('is idempotent: saving twice returns 200 and keeps one row', async () => {
    const app = await loadApp()
    const r = await insertResource()
    const headers = await auth()
    expect((await app.post(`/api/v1/saved/${r.id}`, undefined, headers)).status).toBe(200)
    expect((await app.post(`/api/v1/saved/${r.id}`, undefined, headers)).status).toBe(200)
    expect(await savedResourceIds(USER)).toEqual([r.id])
  })

  it('returns 404 for an unknown resource', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/saved/00000000-0000-4000-8000-000000000000', undefined, await auth())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Resource not found' })
  })

  it('returns 404 for an inactive resource', async () => {
    const app = await loadApp()
    const r = await insertResource({ is_active: false })
    expect((await app.post(`/api/v1/saved/${r.id}`, undefined, await auth())).status).toBe(404)
    expect(await savedResourceIds(USER)).toEqual([])
  })

  it('returns 404 (not 500) for an id that is neither a UUID nor a legacy MongoDB id', async () => {
    const app = await loadApp()
    const res = await app.post('/api/v1/saved/not-a-uuid', undefined, await auth())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Resource not found' })
  })

  // TODO(legacy-mongo-ids): drop these legacy-id cases when legacy ids are retired.
  describe('with a legacy MongoDB id', () => {
    const LEGACY_ID = '65a1b2c3d4e5f6a7b8c9d0e1'

    it("saves the resource under its UUID", async () => {
      const app = await loadApp()
      const r = await insertResource({ title: 'Legacy', legacy_mongo_id: LEGACY_ID })
      const headers = await auth()
      const res = await app.post(`/api/v1/saved/${LEGACY_ID}`, undefined, headers)
      expect(res.status).toBe(200)
      expect(await savedResourceIds(USER)).toEqual([r.id])
      const { data } = await (await app.get('/api/v1/saved', headers)).json()
      expect(data.map((d: { id: string }) => d.id)).toEqual([r.id])
    })

    it('is idempotent, including when already saved by UUID', async () => {
      const app = await loadApp()
      const r = await insertResource({ legacy_mongo_id: LEGACY_ID })
      await saveCourse(USER, r.id)
      expect((await app.post(`/api/v1/saved/${LEGACY_ID}`, undefined, await auth())).status).toBe(200)
      expect(await savedResourceIds(USER)).toEqual([r.id])
    })

    it('returns 404 for an unknown or inactive resource', async () => {
      const app = await loadApp()
      await insertResource({ legacy_mongo_id: 'bbbbbbbbbbbbbbbbbbbbbbbb', is_active: false })
      for (const id of ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb']) {
        expect((await app.post(`/api/v1/saved/${id}`, undefined, await auth())).status).toBe(404)
      }
      expect(await savedResourceIds(USER)).toEqual([])
    })
  })
})

describe('DELETE /api/v1/saved/:resourceId', () => {
  it("removes the caller's saved resource only", async () => {
    const app = await loadApp()
    const r = await insertResource()
    await saveCourse(USER, r.id)
    await saveCourse('someone-else', r.id)
    const res = await app.delete(`/api/v1/saved/${r.id}`, await auth())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await savedResourceIds(USER)).toEqual([])
    expect(await savedResourceIds('someone-else')).toEqual([r.id])
  })

  it('is idempotent: removing something not saved returns 200', async () => {
    const app = await loadApp()
    const r = await insertResource()
    expect((await app.delete(`/api/v1/saved/${r.id}`, await auth())).status).toBe(200)
  })

  it('returns 200 (nothing to remove, not 500) for an id that is neither a UUID nor a legacy MongoDB id', async () => {
    const app = await loadApp()
    const res = await app.delete('/api/v1/saved/not-a-uuid', await auth())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  // TODO(legacy-mongo-ids): drop this case when legacy ids are retired.
  it("removes the caller's saved resource by legacy MongoDB id", async () => {
    const app = await loadApp()
    const r = await insertResource({ legacy_mongo_id: '65a1b2c3d4e5f6a7b8c9d0e1' })
    await saveCourse(USER, r.id)
    await saveCourse('someone-else', r.id)
    const res = await app.delete('/api/v1/saved/65a1b2c3d4e5f6a7b8c9d0e1', await auth())
    expect(res.status).toBe(200)
    expect(await savedResourceIds(USER)).toEqual([])
    expect(await savedResourceIds('someone-else')).toEqual([r.id])
  })
})
