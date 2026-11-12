/**
 * src/api/subjects.ts: topic taxonomy.
 *
 * subjects.ts caches the full topic list in a module variable for the life of
 * the process, so every test loads a fresh app (loadFreshApp) after seeding.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { loadFreshApp } from '../helpers/app.js'
import { resetDb } from '../fakes/db.js'
import { insertTopic } from '../helpers/fixtures.js'

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

  it('sets Cache-Control: no-store', async () => {
    const app = await loadFreshApp()
    const res = await app.get('/api/v1/subjects')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns an empty list when there are no topics', async () => {
    const app = await loadFreshApp()
    expect(await (await app.get('/api/v1/subjects')).json()).toEqual([])
  })

  it('caches topics in memory for the life of the process (documented behaviour)', async () => {
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

  it('is not affected by the list cache (reads live data)', async () => {
    const app = await loadFreshApp()
    await app.get('/api/v1/subjects') // warm the cache while empty
    await insertTopic({ name: 'New', slug: 'new', sort_order: 1 })
    expect((await app.get('/api/v1/subjects/new')).status).toBe(200)
  })
})
