/**
 * src/api/subjects.ts: topic taxonomy, served from an in-memory snapshot that
 * is refreshed every 10 minutes. The snapshot is cleared before each test
 * (test/setup.ts); tests seed first, then make their first request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadFreshApp } from '../helpers/app.js'
import { db, resetDb } from '../fakes/db.js'
import { insertTopic } from '../helpers/fixtures.js'
import { captureLogs, errorLogs } from '../helpers/logs.js'
import { SUBJECTS_CACHE_CONTROL, SUBJECTS_CACHE_MS, SUBJECTS_RETRY_MS } from '../../src/api/subjects.js'

beforeEach(resetDb)

/** Two domains (inserted out of order) with subtopics (also out of order). */
async function seedTaxonomy() {
  const data = await insertTopic({ name: 'Data Science', slug: 'data-science', sort_order: 2, description: 'All things data' })
  const dev = await insertTopic({ name: 'Software Development', slug: 'software-development', sort_order: 1 })
  const ml = await insertTopic({ name: 'Machine Learning', slug: 'machine-learning', parent_id: data.id, sort_order: 2, course_count: 120 })
  const stats = await insertTopic({ name: 'Statistics', slug: 'statistics', parent_id: data.id, sort_order: 1 })
  const web = await insertTopic({ name: 'Web Development', slug: 'web-development', parent_id: dev.id, sort_order: 1 })
  return { data, dev, ml, stats, web }
}

describe('GET /api/v1/subjects', () => {
  it('returns a flat list: each domain followed by its subtopics, all by sort_order', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    const res = await app.get('/api/v1/subjects')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.map((t: { slug: string }) => t.slug)).toEqual([
      'software-development', 'web-development',
      'data-science', 'statistics', 'machine-learning',
    ])
    expect(Object.keys(body[0]).sort()).toEqual([
      'course_count', 'description', 'id', 'meta_description', 'name', 'parent_id', 'slug', 'sort_order',
    ])
  })

  it('lets browsers reuse it for 5 minutes (Cache-Control: public, max-age=300)', async () => {
    const app = await loadFreshApp()
    const res = await app.get('/api/v1/subjects')
    expect(SUBJECTS_CACHE_CONTROL).toBe('public, max-age=300')
    expect(res.headers.get('Cache-Control')).toBe(SUBJECTS_CACHE_CONTROL)
  })

  it('returns an empty list when there are no topics', async () => {
    const app = await loadFreshApp()
    expect(await (await app.get('/api/v1/subjects')).json()).toEqual([])
  })

  it('serves topics from memory between refreshes (documented behaviour)', async () => {
    await insertTopic({ name: 'First', slug: 'first', sort_order: 1 })
    const app = await loadFreshApp()
    expect(await (await app.get('/api/v1/subjects')).json()).toHaveLength(1)
    await insertTopic({ name: 'Added Later', slug: 'added-later', sort_order: 2 })
    expect(await (await app.get('/api/v1/subjects')).json()).toHaveLength(1)
  })
})

describe('GET /api/v1/subjects/tree', () => {
  it('nests subtopics under their domains, both ordered by sort_order', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    const { domains } = await (await app.get('/api/v1/subjects/tree')).json()
    expect(domains.map((d: any) => [d.slug, d.subtopics.map((s: any) => s.slug)])).toEqual([
      ['software-development', ['web-development']],
      ['data-science', ['statistics', 'machine-learning']],
    ])
  })

  it('omits subtopics whose parent is itself a subtopic (tree is two levels deep)', async () => {
    const { ml } = await seedTaxonomy()
    await insertTopic({ name: 'Deep Learning', slug: 'deep-learning', parent_id: ml.id, sort_order: 1 })
    const app = await loadFreshApp()
    const body = JSON.stringify(await (await app.get('/api/v1/subjects/tree')).json())
    expect(body).not.toContain('deep-learning')
  })
})

describe('GET /api/v1/subjects/:slug', () => {
  it('returns a domain with its subtopics ordered by sort_order', async () => {
    const { data } = await seedTaxonomy()
    const app = await loadFreshApp()
    const res = await app.get('/api/v1/subjects/data-science')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.topic).toMatchObject({ id: data.id, slug: 'data-science', description: 'All things data', parent_id: null })
    expect(body.subtopics.map((s: { slug: string }) => s.slug)).toEqual(['statistics', 'machine-learning'])
    expect(body.subtopics[1]).toMatchObject({ course_count: 120 })
    expect(body).not.toHaveProperty('parent')
  })

  it('returns a subtopic with its parent domain', async () => {
    const { data } = await seedTaxonomy()
    const app = await loadFreshApp()
    const body = await (await app.get('/api/v1/subjects/machine-learning')).json()
    expect(body.topic).toMatchObject({ slug: 'machine-learning', parent_id: data.id })
    expect(body.parent).toEqual({ id: data.id, name: 'Data Science', slug: 'data-science' })
    expect(body).not.toHaveProperty('subtopics')
  })

  it('returns an empty subtopics list for a domain without children', async () => {
    await insertTopic({ name: 'Design', slug: 'design', sort_order: 1 })
    const app = await loadFreshApp()
    expect((await (await app.get('/api/v1/subjects/design')).json()).subtopics).toEqual([])
  })

  it('returns 404 for an unknown slug', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    const res = await app.get('/api/v1/subjects/underwater-basket-weaving')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('returns the full topic row, and the same fields as a direct query would', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    const { topic } = await (await app.get('/api/v1/subjects/data-science')).json()
    expect(Object.keys(topic).sort()).toEqual([
      'course_count', 'created_at', 'cross_provider_insights', 'description', 'id', 'insights_updated_at',
      'meta_description', 'name', 'parent_id', 'slug', 'sort_order', 'updated_at',
    ])
  })

  it('orders subtopics by sort_order with missing ones last', async () => {
    const domain = await insertTopic({ name: 'D', slug: 'd', sort_order: 1 })
    await insertTopic({ name: 'No order', slug: 'no-order', parent_id: domain.id, sort_order: null })
    await insertTopic({ name: 'Second', slug: 'second', parent_id: domain.id, sort_order: 2 })
    await insertTopic({ name: 'Also no order', slug: 'also-no-order', parent_id: domain.id, sort_order: null })
    await insertTopic({ name: 'First', slug: 'first', parent_id: domain.id, sort_order: 1 })
    const app = await loadFreshApp()
    const { subtopics } = await (await app.get('/api/v1/subjects/d')).json()
    const slugs = subtopics.map((t: { slug: string }) => t.slug)
    expect(slugs.slice(0, 2)).toEqual(['first', 'second'])
    expect(slugs.slice(2).sort()).toEqual(['also-no-order', 'no-order'])
  })

  it('sets Cache-Control on found topics, not on 404s', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    expect((await app.get('/api/v1/subjects/data-science')).headers.get('Cache-Control')).toBe(SUBJECTS_CACHE_CONTROL)
    expect((await app.get('/api/v1/subjects/machine-learning')).headers.get('Cache-Control')).toBe(SUBJECTS_CACHE_CONTROL)
    expect((await app.get('/api/v1/subjects/tree')).headers.get('Cache-Control')).toBe(SUBJECTS_CACHE_CONTROL)
    expect((await app.get('/api/v1/subjects/nope')).headers.get('Cache-Control')).toBeNull()
  })
})

describe('taxonomy snapshot (one query for every subjects endpoint)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
  afterEach(() => { vi.useRealTimers() })
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

  it('serves the list, the tree, domains, subtopics and unknown slugs from one database query', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    const select = vi.spyOn(db, 'select')
    for (const path of ['', '/tree', '/data-science', '/machine-learning', '/made-up-1', '/made-up-2']) {
      await app.get(`/api/v1/subjects${path}`)
    }
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('shares one query between simultaneous requests', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    const select = vi.spyOn(db, 'select')
    const responses = await Promise.all(Array.from({ length: 5 }, () => app.get('/api/v1/subjects/data-science')))
    expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200, 200])
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('picks up a changed taxonomy within 10 minutes, without a restart', async () => {
    await insertTopic({ name: 'First', slug: 'first', sort_order: 1 })
    const app = await loadFreshApp()
    expect(await (await app.get('/api/v1/subjects')).json()).toHaveLength(1)
    await insertTopic({ name: 'Added Later', slug: 'added-later', sort_order: 2 })

    advance(SUBJECTS_CACHE_MS - 1_000)
    expect((await app.get('/api/v1/subjects/added-later')).status).toBe(404)
    advance(1_000)
    expect(SUBJECTS_CACHE_MS).toBe(10 * 60_000)
    expect((await app.get('/api/v1/subjects/added-later')).status).toBe(200)
    expect(await (await app.get('/api/v1/subjects')).json()).toHaveLength(2)
  })

  it('keeps serving the last taxonomy when a refresh fails, logs it, and retries after 30 seconds', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    expect((await app.get('/api/v1/subjects/data-science')).status).toBe(200)

    const logs = captureLogs()
    advance(SUBJECTS_CACHE_MS)
    const select = vi.spyOn(db, 'select').mockImplementation(() => { throw new Error('connect ECONNREFUSED') })
    expect((await app.get('/api/v1/subjects/data-science')).status).toBe(200) // stale, not 500
    expect((await app.get('/api/v1/subjects')).status).toBe(200)
    expect(select).toHaveBeenCalledTimes(1) // no retry on every request
    expect(errorLogs(logs(), 'subjects_refresh_failed')).toHaveLength(1)

    select.mockRestore()
    await insertTopic({ name: 'New', slug: 'new', sort_order: 9 })
    advance(SUBJECTS_RETRY_MS)
    expect(SUBJECTS_RETRY_MS).toBe(30_000)
    expect((await app.get('/api/v1/subjects/new')).status).toBe(200)
  })

  it('answers 500 when the very first load fails (nothing to fall back on), and tries again next time', async () => {
    await seedTaxonomy()
    const app = await loadFreshApp()
    vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('connect ECONNREFUSED') })
    expect((await app.get('/api/v1/subjects')).status).toBe(500)
    expect((await app.get('/api/v1/subjects')).status).toBe(200)
  })
})
