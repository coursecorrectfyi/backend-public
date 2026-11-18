/** src/api/resources.ts: hybrid search (full-text + pgvector), pagination, detail. */
import { beforeEach, describe, expect, it } from 'vitest'
import { loadApp, type TestClient } from '../helpers/app.js'
import { resetDb } from '../fakes/db.js'
import { embedQuery, unitVector, vec } from '../fakes/embedding.js'
import { insertResource, insertResources } from '../helpers/fixtures.js'
import { captureLogs, errorLogs } from '../helpers/logs.js'
import { SEARCH_LIMITS } from '../../src/api/resources.js'
import { LEVELS, RESOURCE_TYPES } from '../../src/search/filters.js'
import { SEARCH_CONFIG } from '../../src/search/config.js'

beforeEach(resetDb)

type Row = Awaited<ReturnType<typeof insertResource>>
interface SearchBody { data: Array<Record<string, any>>; next_cursor: string | null; vector_search: boolean }

async function search(app: TestClient, query: string): Promise<SearchBody> {
  const res = await app.get(`/api/v1/resources/search?${query}`)
  expect(res.status).toBe(200)
  return res.json()
}

/** Follows next_cursor until the end and returns every id, in order. */
async function searchAllPages(app: TestClient, query: string, pageSize: number): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const body = await search(app, `${query}&limit=${pageSize}${cursor ? `&cursor=${cursor}` : ''}`)
    expect(body.data.length).toBeLessThanOrEqual(pageSize)
    ids.push(...body.data.map(r => r.id as string))
    cursor = body.next_cursor
    if (!cursor) return ids
  }
  throw new Error('pagination did not terminate')
}

const titles = (body: SearchBody) => body.data.map(r => r.title)

describe('GET /api/v1/resources/search: validation', () => {
  it.each(['', 'q=', 'q=%20%20%20'])('returns 400 when q is missing or blank (%s)', async query => {
    const app = await loadApp()
    const res = await app.get(`/api/v1/resources/search?${query}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing required query parameter: q' })
  })
})

describe('GET /api/v1/resources/search: matching', () => {
  it('matches title, summary, skills, institution and provider via the search_document trigger', async () => {
    const app = await loadApp()
    await insertResources([
      { title: 'Kubernetes in Production' },
      { title: 'Course B', ai_summary: 'Learn kubernetes deployments' },
      { title: 'Course C', skills: ['Kubernetes', 'Docker'] },
      { title: 'Course D', institution: 'Kubernetes Academy' },
      { title: 'Unrelated', ai_summary: 'Watercolour painting' },
    ])
    const body = await search(app, 'q=kubernetes')
    expect(titles(body).sort()).toEqual(['Course B', 'Course C', 'Course D', 'Kubernetes in Production'])
    expect((await search(app, 'q=udacity')).data).toEqual([])
  })

  it('uses English stemming (plural/singular match)', async () => {
    const app = await loadApp()
    await insertResource({ title: 'Neural Networks Explained' })
    expect(titles(await search(app, 'q=network'))).toEqual(['Neural Networks Explained'])
  })

  it('keeps search_document in sync when a resource is updated', async () => {
    const app = await loadApp()
    const { db } = await import('../fakes/db.js')
    const { learning_resources } = await import('../../src/db/schema.js')
    const { eq } = await import('drizzle-orm')
    const row = await insertResource({ title: 'Old Title' })
    await db.update(learning_resources).set({ title: 'Rust Ownership' }).where(eq(learning_resources.id, row.id))
    expect(titles(await search(app, 'q=rust'))).toEqual(['Rust Ownership'])
    expect((await search(app, 'q=old')).data).toEqual([])
  })

  it('excludes inactive resources', async () => {
    const app = await loadApp()
    await insertResources([{ title: 'Python Active' }, { title: 'Python Retired', is_active: false }])
    expect(titles(await search(app, 'q=python'))).toEqual(['Python Active'])
  })

  it('does not let user input break out of the query (treated as plain text)', async () => {
    const app = await loadApp()
    await insertResource({ title: 'Python' })
    for (const q of ["python' OR 1=1 --", 'python & | ! :*', '); DROP TABLE learning_resources; --']) {
      const res = await app.get(`/api/v1/resources/search?q=${encodeURIComponent(q)}`)
      expect(res.status).toBe(200)
    }
    expect((await search(app, 'q=python')).data).toHaveLength(1)
  })
})

describe('GET /api/v1/resources/search: response shape', () => {
  it('returns public fields only, with url = affiliate_url ?? source_url', async () => {
    const app = await loadApp()
    await insertResources([
      { title: 'Go With Affiliate', source_url: 'https://src/a', affiliate_url: 'https://aff/a', embedding: unitVector(0) },
      { title: 'Go Without Affiliate', source_url: 'https://src/b', affiliate_url: null },
    ])
    const body = await search(app, 'q=go')
    const byTitle = Object.fromEntries(body.data.map(r => [r.title, r]))
    expect(byTitle['Go With Affiliate']!.url).toBe('https://aff/a')
    expect(byTitle['Go Without Affiliate']!.url).toBe('https://src/b')

    expect(Object.keys(body.data[0]!).sort()).toEqual([
      'ai_summary', 'career_paths', 'duration_hours', 'has_certificate', 'id', 'institution',
      'is_free', 'is_self_paced', 'language', 'level', 'num_ratings', 'provider', 'provider_type',
      'rating', 'resource_type', 'skills', 'title', 'url',
    ])
  })
})

describe('GET /api/v1/resources/search: hybrid ranking', () => {
  it('embeds the trimmed query and reports vector_search: true', async () => {
    const app = await loadApp()
    await insertResource({ title: 'Python' })
    const body = await search(app, 'q=%20%20python%20')
    expect(embedQuery).toHaveBeenCalledWith('python')
    expect(body.vector_search).toBe(true)
  })

  it('falls back to keyword-only search when embedding fails', async () => {
    const app = await loadApp()
    embedQuery.mockRejectedValue(new Error('Vertex AI embedding API 503'))
    await insertResource({ title: 'Python Basics', embedding: unitVector(0) })
    const body = await search(app, 'q=python')
    expect(body.vector_search).toBe(false)
    expect(titles(body)).toEqual(['Python Basics'])
  })

  it('ranks a semantically closer resource first when text relevance is equal', async () => {
    const app = await loadApp()
    const far = await insertResource({ title: 'Python Course', embedding: unitVector(1) })
    const near = await insertResource({ title: 'Python Course', embedding: unitVector(0) })
    embedQuery.mockResolvedValue(unitVector(0))
    // Whatever their keyword ranks (equal text: the id decides), near is also the top
    // semantic match, and far is beyond the distance floor.
    expect((await search(app, 'q=python')).data.map(r => r.id)).toEqual([near.id, far.id])
  })

  it('a resource without an embedding yet counts its keyword rank for the semantic side too', async () => {
    const app = await loadApp()
    // Best keyword match (title), but the embedding job hasn't run for it.
    const titleMatch = await insertResource({ title: 'Python', embedding: null })
    // Weaker keyword match (summary), but the closest semantic match.
    const summaryMatch = await insertResource({ title: 'Intro', ai_summary: 'Learn python', embedding: unitVector(0) })
    embedQuery.mockResolvedValue(unitVector(0))
    // Plain rank fusion would put summaryMatch first (found by both sides).
    expect((await search(app, 'q=python')).data.map(r => r.id)).toEqual([titleMatch.id, summaryMatch.id])
  })

  it('returns a semantic match that has no word in common with the query', async () => {
    const app = await loadApp()
    await insertResource({ title: 'Gardening', embedding: unitVector(0) })
    embedQuery.mockResolvedValue(unitVector(0))
    expect(titles(await search(app, 'q=python'))).toEqual(['Gardening'])
  })

  it('does not return a resource beyond the semantic distance floor (no keyword match either)', async () => {
    const app = await loadApp()
    await insertResource({ title: 'Gardening', embedding: unitVector(1) }) // cosine distance 1 from the query
    embedQuery.mockResolvedValue(unitVector(0))
    expect((await search(app, 'q=python')).data).toEqual([])
  })

  it('ranks title matches above institution matches (search_document weights)', async () => {
    const app = await loadApp()
    embedQuery.mockRejectedValue(new Error('offline')) // isolate text relevance
    await insertResources([
      { title: 'Intro Course', institution: 'Harvard' },
      { title: 'Harvard Negotiation' },
    ])
    expect(titles(await search(app, 'q=harvard'))).toEqual(['Harvard Negotiation', 'Intro Course'])
  })
})

describe('GET /api/v1/resources/search: filters', () => {
  async function seed() {
    return insertResources([
      { title: 'Python A', level: 'beginner', provider: 'coursera', language: 'en', resource_type: 'course', is_free: true, has_certificate: true },
      { title: 'Python B', level: 'intermediate', provider: 'udemy', language: 'es', resource_type: 'program', is_free: false, has_certificate: false },
      { title: 'Python C', level: 'advanced', provider: 'edx', language: 'en', resource_type: 'degree', is_free: null, has_certificate: null },
      { title: 'Python D', level: 'beginner', provider: 'udemy', language: 'fr', resource_type: 'course', is_free: true, has_certificate: false },
    ])
  }

  it.each([
    ['level=beginner', ['Python A', 'Python D']],
    ['level=beginner&level=advanced', ['Python A', 'Python C', 'Python D']],
    ['provider=udemy', ['Python B', 'Python D']],
    ['provider=edx&provider=coursera', ['Python A', 'Python C']],
    ['language=en', ['Python A', 'Python C']],
    ['language=es&language=fr', ['Python B', 'Python D']],
    ['resource_type=course', ['Python A', 'Python D']],
    ['resource_type=degree&resource_type=program', ['Python B', 'Python C']],
    ['is_free=true', ['Python A', 'Python D']],
    ['is_free=false', ['Python B']],
    ['has_certificate=true', ['Python A']],
    ['has_certificate=false', ['Python B', 'Python D']],
    ['is_free=yes&has_certificate=1', ['Python A', 'Python B', 'Python C', 'Python D']], // invalid booleans are ignored
    ['provider=udemy&level=beginner&is_free=true', ['Python D']],
    ['provider=pluralsight', []],
  ])('%s', async (filter, expected) => {
    const app = await loadApp()
    await seed()
    expect(titles(await search(app, `q=python&${filter}`)).sort()).toEqual(expected)
  })
})

describe('GET /api/v1/resources/search: limit', () => {
  beforeEach(async () => {
    await insertResources(Array.from({ length: 55 }, (_, i) => ({ title: `Python ${i}` })))
  })

  it.each([
    ['(default)', '', 20],
    ['limit=5', '&limit=5', 5],
    ['limit=50', '&limit=50', 50],
    ['limit=100 is capped at 50', '&limit=100', 50],
    ['limit=0 is raised to 1', '&limit=0', 1],
    ['limit=-3 is raised to 1', '&limit=-3', 1],
    ['limit=abc falls back to the default', '&limit=abc', 20],
    ['limit= (empty) falls back to the default', '&limit=', 20],
  ])('%s', async (_label, param, expected) => {
    const app = await loadApp()
    const body = await search(app, `q=python${param}`)
    expect(body.data).toHaveLength(expected)
    expect(body.next_cursor).not.toBeNull()
  })

  it('returns next_cursor: null on the last page', async () => {
    const app = await loadApp()
    const body = await search(app, 'q=python&limit=50&sort=newest')
    const last = await search(app, `q=python&limit=50&sort=newest&cursor=${body.next_cursor}`)
    expect(last.data).toHaveLength(5)
    expect(last.next_cursor).toBeNull()
  })
})

describe('GET /api/v1/resources/search: sorting and cursor pagination', () => {
  // Ties and NULLs on purpose: these are where keyset pagination usually breaks.
  const base = new Date('2025-01-01T00:00:00.000Z').getTime()
  const dataset = [
    { rating: 4.5, num_ratings: 100, duration_hours: 10, created_at: new Date(base + 3000) },
    { rating: 4.5, num_ratings: null, duration_hours: null, created_at: new Date(base + 3000) },
    { rating: null, num_ratings: 100, duration_hours: 2.5, created_at: new Date(base + 1000) },
    { rating: 3.0, num_ratings: 5000, duration_hours: 10, created_at: new Date(base + 5000) },
    { rating: null, num_ratings: null, duration_hours: null, created_at: new Date(base + 1000) },
    { rating: 5.0, num_ratings: 1, duration_hours: 40, created_at: new Date(base + 2000) },
    { rating: 4.5, num_ratings: 100, duration_hours: 2.5, created_at: new Date(base + 3000) },
    { rating: 2.0, num_ratings: 0, duration_hours: 0.5, created_at: new Date(base + 4000) },
    { rating: null, num_ratings: 7, duration_hours: 40, created_at: new Date(base + 4000) },
  ]

  const byIdAsc = (a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  // sort=rating orders by the weighted (Bayesian) rating, computed here independently of the code.
  const { priorMean, priorCount } = SEARCH_CONFIG.rating
  const weighted = (r: Row) => r.rating === null ? null : ((r.num_ratings ?? 0) * r.rating + priorCount * priorMean) / ((r.num_ratings ?? 0) + priorCount)
  const nullsLast = (value: (r: Row) => number | null, dir: 1 | -1) => (a: Row, b: Row) => {
    const x = value(a), y = value(b)
    if (x === null && y === null) return byIdAsc(a, b)
    if (x === null) return 1
    if (y === null) return -1
    return x !== y ? (x - y) * dir : byIdAsc(a, b)
  }
  const comparators: Record<string, (a: Row, b: Row) => number> = {
    rating: nullsLast(weighted, -1),
    most_reviewed: nullsLast(r => r.num_ratings, -1),
    duration_asc: nullsLast(r => r.duration_hours, 1),
    duration_desc: nullsLast(r => r.duration_hours, -1),
    newest: (a, b) => b.created_at.getTime() - a.created_at.getTime() || byIdAsc(a, b),
  }

  it.each(Object.keys(comparators))('sort=%s: orders correctly across pages with no duplicates or gaps', async sort => {
    const app = await loadApp()
    const rows = await insertResources(dataset.map((d, i) => ({ ...d, title: `Python ${i}` })))
    const expected = [...rows].sort(comparators[sort]).map(r => r.id)

    // One big page gives the true order; small pages must reproduce it exactly.
    const single = await search(app, `q=python&sort=${sort}&limit=50`)
    expect(single.data.map(r => r.id)).toEqual(expected)
    for (const pageSize of [1, 2, 4]) {
      expect(await searchAllPages(app, `q=python&sort=${sort}`, pageSize)).toEqual(expected)
    }
  })

  it('sort=relevance (keyword only): pages through tied and distinct scores without duplicates or gaps', async () => {
    const app = await loadApp()
    embedQuery.mockRejectedValue(new Error('offline'))
    await insertResources([
      { title: 'Python' }, { title: 'Python' }, { title: 'Python' },
      { title: 'Python Python Python' }, { title: 'Intro', skills: ['python'] },
      { title: 'Intro', institution: 'Python Institute' }, { title: 'Python for Python devs' },
    ])
    const all = (await search(app, 'q=python&limit=50')).data.map(r => r.id)
    expect(all).toHaveLength(7)
    for (const pageSize of [1, 2, 3]) {
      expect(await searchAllPages(app, 'q=python', pageSize)).toEqual(all)
    }
  })

  it('sort=relevance (hybrid): pages through without duplicates or gaps', async () => {
    const app = await loadApp()
    embedQuery.mockResolvedValue(vec({ 0: 0.8, 1: 0.6 }))
    await insertResources([
      { title: 'Python', embedding: vec({ 0: 1 }) },
      { title: 'Python', embedding: vec({ 1: 1 }) },
      { title: 'Python', embedding: vec({ 0: 0.6, 1: 0.8 }) },
      { title: 'Python', embedding: null },
      { title: 'Python', embedding: null },
      { title: 'Python Python', embedding: vec({ 2: 1 }) },
      { title: 'Intro', skills: ['python'], embedding: vec({ 0: 0.8, 1: 0.6 }) },
      { title: 'Intro', institution: 'Python U', embedding: vec({ 0: 0.3, 3: 0.7 }) },
    ])
    const all = (await search(app, 'q=python&limit=50')).data.map(r => r.id)
    expect(all).toHaveLength(8)
    for (const pageSize of [1, 2, 3]) {
      expect(await searchAllPages(app, 'q=python', pageSize)).toEqual(all)
    }
  })

  it('treats an unknown sort value as relevance', async () => {
    const app = await loadApp()
    await insertResources([{ title: 'Python' }, { title: 'Python Python' }, { title: 'Intro', skills: ['python'] }])
    const relevance = (await search(app, 'q=python')).data.map(r => r.id)
    expect((await search(app, 'q=python&sort=bogus')).data.map(r => r.id)).toEqual(relevance)
    expect(await searchAllPages(app, 'q=python&sort=bogus', 1)).toEqual(relevance)
  })

  it('refuses a malformed cursor with 400 (a client looping on page 1 would show duplicates)', async () => {
    const app = await loadApp()
    await insertResources([{ title: 'Python 1' }, { title: 'Python 2' }])
    for (const cursor of ['not-base64-json', 'e30', '%%%']) {
      const res = await app.get(`/api/v1/resources/search?q=python&sort=newest&cursor=${encodeURIComponent(cursor)}`)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid cursor' })
    }
  })
})

describe('GET /api/v1/resources/search: input limits (checked before any paid work)', () => {
  const get = async (query: string) => (await loadApp()).get(`/api/v1/resources/search?${query}`)

  it('keeps the documented limits', () => {
    expect(SEARCH_LIMITS).toEqual({ queryMaxChars: 200, filterMaxValues: 20, filterValueMaxChars: 50, cursorMaxChars: 1_000 })
    expect(LEVELS).toEqual(['beginner', 'intermediate', 'advanced', 'all_levels'])
    expect(RESOURCE_TYPES).toEqual(['course', 'program', 'degree', 'project', 'certification', 'code_along'])
  })

  it('cuts q to 200 characters quietly, after collapsing whitespace, for both keyword and semantic search', async () => {
    const app = await loadApp()
    // Keyword search needs every word to match: with "zebra" in the query, only the second would match
    await insertResources([{ title: 'Python filler' }, { title: 'Python filler zebra' }])
    const long = `python${' filler'.repeat(40)} zebra` // "zebra" is past the 200th character
    const body = await search(app, `q=${encodeURIComponent(long)}`)
    const embedded = embedQuery.mock.calls[0]![0]
    expect(embedded.length).toBeLessThanOrEqual(200)
    expect(embedded.startsWith('python filler filler')).toBe(true)
    expect(embedded).not.toContain('zebra')
    expect(titles(body).sort()).toEqual(['Python filler', 'Python filler zebra']) // same cut text
  })

  it('collapses whitespace and line breaks in q', async () => {
    const app = await loadApp()
    await search(app, `q=${encodeURIComponent('  learn \n\t  python  ')}`)
    expect(embedQuery).toHaveBeenCalledWith('learn python')
  })

  it.each([
    ['a level the API does not know', 'level=expert', { error: 'Invalid level: "expert"', allowed: [...LEVELS] }],
    ['a resource_type the API does not know', 'resource_type=bootcamp', { error: 'Invalid resource_type: "bootcamp"', allowed: [...RESOURCE_TYPES] }],
    ['more than 20 values for one filter', Array.from({ length: 21 }, (_, i) => `provider=p${i}`).join('&'), { error: 'Too many provider values', maxValues: 20 }],
    ['a value over 50 characters', `language=${'x'.repeat(51)}`, { error: 'A language value is too long', maxLength: 50 }],
  ])('returns 400 for %s, without calling the embedding API', async (_label, filter, body) => {
    const res = await get(`q=python&${filter}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(body)
    expect(embedQuery).not.toHaveBeenCalled()
  })

  it('accepts 20 values and 50-character values, and ignores empty ones', async () => {
    const app = await loadApp()
    await insertResources([{ title: 'Python', provider: 'coursera' }])
    const twenty = Array.from({ length: 19 }, (_, i) => `provider=p${i}`).join('&')
    expect(titles(await search(app, `q=python&${twenty}&provider=coursera`))).toEqual(['Python'])
    expect((await app.get(`/api/v1/resources/search?q=python&language=${'x'.repeat(50)}`)).status).toBe(200)
    expect(titles(await search(app, 'q=python&level=&provider=&resource_type='))).toEqual(['Python'])
  })
})

describe('GET /api/v1/resources/search: cursor validation', () => {
  const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url')
  const ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a60'

  const TS = '2025-01-01T00:00:03.123456Z'
  const v2 = (sort: string, values: unknown[], extra: Record<string, unknown> = {}) =>
    ({ v: 2, sort, mode: 'hybrid', values, id: ID, ...extra })

  it.each([
    ['relevance', v2('relevance', [0.032, 4.61])],
    ['relevance', v2('relevance', [0.016, null], { mode: 'keyword' })],
    ['rating', v2('rating', [4.5])],
    ['rating', v2('rating', [null])],
    ['most_reviewed', v2('most_reviewed', [100])],
    ['duration_asc', v2('duration_asc', [null])],
    ['duration_desc', v2('duration_desc', [2.5])],
    ['newest', v2('newest', [TS])],
  ])('accepts a well-formed %s cursor', async (sort, payload) => {
    const app = await loadApp()
    const res = await app.get(`/api/v1/resources/search?q=python&sort=${sort}&cursor=${encode(payload)}`)
    expect(res.status).toBe(200)
  })

  it.each([
    // The probes from the abuse report (P5): these used to reach Postgres and return 500
    ['a non-UUID id', 'relevance', v2('relevance', [0.5, null], { id: 'x' })],
    ['a missing score', 'relevance', v2('relevance', [])],
    ['an invalid created_at', 'newest', v2('newest', ['yesterday'])],
    // Cursors from before version 2 (the ranking mode wasn't recorded): the frontend offers to reload
    ['a version 1 relevance cursor', 'relevance', { sort: 'relevance', id: ID, score: 0.5 }],
    ['a version 1 newest cursor', 'newest', { sort: 'newest', id: ID, created_at: '2025-01-01T00:00:03.000Z' }],
    // and the other ways a cursor can be wrong
    ['another version', 'relevance', v2('relevance', [0.5, null], { v: 3 })],
    ['a missing mode', 'relevance', v2('relevance', [0.5, null], { mode: undefined })],
    ['an unknown mode', 'relevance', v2('relevance', [0.5, null], { mode: 'semantic' })],
    ['values that are not a list', 'rating', v2('rating', [], { values: 4.5 })],
    ['too many values', 'rating', v2('rating', [4.5, 1])],
    ['a null score (relevance scores are never null)', 'relevance', v2('relevance', [null, 4.5])],
    ['a score that is a string', 'relevance', v2('relevance', ['0.5; DROP TABLE', null])],
    ['a fractional num_ratings', 'most_reviewed', v2('most_reviewed', [1.5])],
    ['a rating that is a string', 'rating', v2('rating', ['4.5'])],
    ['a duration that is not a number', 'duration_asc', v2('duration_asc', ['10h'])],
    ['a created_at without microseconds', 'newest', v2('newest', ['2025-01-01T00:00:03.000Z'])],
    ['a created_at Postgres might misread', 'newest', v2('newest', ['01/02/2025'])],
    ['a null created_at', 'newest', v2('newest', [null])],
    ['a cursor made for another sort', 'newest', v2('rating', [4])],
    ['a relevance cursor used with an unknown sort (which means relevance) is fine, but a rating one is not', 'bogus', v2('rating', [4])],
    ['a JSON array', 'relevance', [1, 2]],
    ['JSON null', 'relevance', null],
  ])('returns 400 for %s, without calling the embedding API', async (_label, sort, payload) => {
    const app = await loadApp()
    const res = await app.get(`/api/v1/resources/search?q=python&sort=${sort}&cursor=${encode(payload)}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid cursor' })
    expect(embedQuery).not.toHaveBeenCalled()
  })

  it('accepts a relevance cursor with an unknown sort (which means relevance)', async () => {
    const app = await loadApp()
    const res = await app.get(`/api/v1/resources/search?q=python&sort=bogus&cursor=${encode(v2('relevance', [0.5, null]))}`)
    expect(res.status).toBe(200)
  })

  it('returns 400 for a cursor over 1,000 characters', async () => {
    const app = await loadApp()
    const res = await app.get(`/api/v1/resources/search?q=python&cursor=${'a'.repeat(1_001)}`)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/resources/search: embedding calls', () => {
  it('pages through a search with one embedding call (P6: it used to be one per page)', async () => {
    const app = await loadApp()
    await insertResources(Array.from({ length: 10 }, (_, i) => ({ title: `Python ${i}` })))
    const ids = await searchAllPages(app, 'q=python', 2)
    expect(ids).toHaveLength(10) // 5 pages
    expect(embedQuery).toHaveBeenCalledTimes(1)
  })

  it('reuses the embedding for a popular query, and embeds a different query separately', async () => {
    const app = await loadApp()
    await search(app, 'q=learn%20python')
    await search(app, 'q=learn%20%20python%20') // same text after whitespace is collapsed
    await search(app, 'q=learn%20sql')
    expect(embedQuery.mock.calls.map(([text]) => text)).toEqual(['learn python', 'learn sql'])
  })

  it.each(['rating', 'most_reviewed', 'duration_asc', 'duration_desc', 'newest'])(
    'embeds the query for sort=%s too (every sort orders the same results), reusing the cached embedding', async sort => {
      const app = await loadApp()
      await insertResources([{ title: 'Python' }])
      await search(app, 'q=python') // the frontend's default sort comes first
      const body = await search(app, `q=python&sort=${sort}`)
      expect(titles(body)).toEqual(['Python'])
      expect(body.vector_search).toBe(true)
      expect(embedQuery).toHaveBeenCalledTimes(1)
    },
  )

  it('falls back to keyword-only for other sorts too when the embedding fails', async () => {
    const app = await loadApp()
    await insertResources([{ title: 'Python' }])
    embedQuery.mockRejectedValue(new Error('Vertex AI embedding API 503'))
    const body = await search(app, 'q=python&sort=newest')
    expect(titles(body)).toEqual(['Python'])
    expect(body.vector_search).toBe(false)
  })

  it('falls back to keyword-only on a timeout, logs it, and tries the API again on the next search', async () => {
    const app = await loadApp()
    const logs = captureLogs()
    await insertResources([{ title: 'Python' }])
    embedQuery.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
    const degraded = await search(app, 'q=python')
    expect(degraded.vector_search).toBe(false)
    expect(titles(degraded)).toEqual(['Python'])
    expect(errorLogs(logs(), 'search_embedding_failed')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('TimeoutError') }),
    ])

    expect((await search(app, 'q=python')).vector_search).toBe(true) // the failure wasn't cached
    expect(embedQuery).toHaveBeenCalledTimes(2)
  })
})

describe('GET /api/v1/resources/search: search log event', () => {
  const searchEvents = (entries: Array<Record<string, unknown>>) => entries.filter(e => e.event === 'search')

  it('logs one line per search with counts only, never the query text', async () => {
    const app = await loadApp()
    await insertResources([{ title: 'Python Basics' }, { title: 'Python Advanced' }, { title: 'Python Data' }])
    const logs = captureLogs()
    const body = await search(app, 'q=My%20Secret%20python&limit=2&level=beginner&provider=coursera&is_free=true&is_free=maybe')
    const [event, ...others] = searchEvents(logs())
    expect(others).toEqual([])
    expect(event).toEqual({
      level: 'info', severity: 'INFO', ts: expect.any(String),
      event: 'search', sort: 'relevance', mode: 'hybrid', embedding: 'computed', page: 'first',
      results: body.data.length, has_more: false, query_words: 3, corrected: false,
      filters: ['level', 'provider', 'is_free'],
      keyword_tier: 'any', keyword_candidates: 0, semantic_candidates: 0, scan_cap_hit: false,
      duration_ms: expect.any(Number),
    })
    expect(JSON.stringify(logs())).not.toMatch(/secret|python|coursera|beginner/i)
  })

  it('reports the zero-result case, paging, the cache and the ranking mode', async () => {
    const app = await loadApp()
    await insertResources(Array.from({ length: 3 }, (_, i) => ({ title: `Python ${i}` })))
    const logs = captureLogs()
    const page1 = await search(app, 'q=python&limit=2')
    await search(app, `q=python&limit=2&cursor=${page1.next_cursor}`)
    await search(app, 'q=gardening')
    await search(app, 'q=python&sort=rating')
    embedQuery.mockRejectedValueOnce(new Error('Vertex AI embedding API 503'))
    const keywordPage1 = await search(app, 'q=python%20rust&limit=2')
    await search(app, `q=python%20rust&limit=2&cursor=${keywordPage1.next_cursor}`) // continues without embedding

    const pick = ({ sort, mode, embedding, page, results, has_more }: Record<string, unknown>) =>
      ({ sort, mode, embedding, page, results, has_more })
    expect(searchEvents(logs()).map(pick)).toEqual([
      { sort: 'relevance', mode: 'hybrid', embedding: 'computed', page: 'first', results: 2, has_more: true },
      { sort: 'relevance', mode: 'hybrid', embedding: 'cached', page: 'next', results: 1, has_more: false },
      { sort: 'relevance', mode: 'hybrid', embedding: 'computed', page: 'first', results: 0, has_more: false },
      { sort: 'rating', mode: 'hybrid', embedding: 'cached', page: 'first', results: 3, has_more: false },
      { sort: 'relevance', mode: 'keyword', embedding: 'failed', page: 'first', results: 2, has_more: true },
      { sort: 'relevance', mode: 'keyword', embedding: 'not_needed', page: 'next', results: 1, has_more: false },
    ])
  })

  it('reports the keyword tier and the candidates from each side', async () => {
    const app = await loadApp()
    await insertResources([
      { title: 'Python Data', embedding: unitVector(0) },
      { title: 'Python Web', embedding: unitVector(1) }, // beyond the semantic distance floor
      { title: 'Gardening', embedding: unitVector(0) }, // semantic only
    ])
    embedQuery.mockResolvedValue(unitVector(0))
    const logs = captureLogs()
    await search(app, 'q=python') // one term: the "all words" tier is all there is
    await search(app, 'q=python%20data') // "all words" finds 1 of the 100 wanted: "any word" adds the rest
    await search(app, 'q=how%20to') // stop words only: no keyword terms
    const pick = ({ keyword_tier, keyword_candidates, semantic_candidates, scan_cap_hit }: Record<string, unknown>) =>
      ({ keyword_tier, keyword_candidates, semantic_candidates, scan_cap_hit })
    expect(searchEvents(logs()).map(pick)).toEqual([
      { keyword_tier: 'all', keyword_candidates: 2, semantic_candidates: 2, scan_cap_hit: false },
      { keyword_tier: 'any', keyword_candidates: 2, semantic_candidates: 2, scan_cap_hit: false },
      { keyword_tier: 'none', keyword_candidates: 0, semantic_candidates: 2, scan_cap_hit: false },
    ])
  })

  it('does not log refused requests (400): they were never searched', async () => {
    const app = await loadApp()
    const logs = captureLogs()
    expect((await app.get('/api/v1/resources/search?q=python&level=expert')).status).toBe(400)
    expect((await app.get('/api/v1/resources/search?q=python&cursor=bogus')).status).toBe(400)
    expect(searchEvents(logs())).toEqual([])
  })
})

describe('GET /api/v1/resources/:id', () => {
  it('returns the full detail by UUID, with url and without internal fields', async () => {
    const app = await loadApp()
    const insights = {
      reviewInsights: { sentiment: 'positive' as const, pros: ['Clear'], cons: ['Short'], representative_quotes: ['Great'] },
    }
    const row = await insertResource({
      title: 'Deep Learning', provider: 'coursera', external_id: 'dl-1', legacy_mongo_id: '65a1b2c3d4e5f6a7b8c9d0e1',
      affiliate_url: 'https://aff/dl', source_url: 'https://src/dl', ai_insights: insights, rating: 4.8,
      skills: ['PyTorch'], embedding: unitVector(0),
    })
    const res = await app.get(`/api/v1/resources/${row.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      id: row.id, title: 'Deep Learning', external_id: 'dl-1', legacy_mongo_id: '65a1b2c3d4e5f6a7b8c9d0e1',
      url: 'https://aff/dl', ai_insights: insights, rating: 4.8, skills: ['PyTorch'],
    })
    for (const hidden of ['is_active', 'source_url', 'affiliate_url', 'embedding', 'search_document', 'raw_id']) {
      expect(body).not.toHaveProperty(hidden)
    }
  })

  it('falls back to source_url when there is no affiliate link', async () => {
    const app = await loadApp()
    const row = await insertResource({ source_url: 'https://src/x', affiliate_url: null })
    expect((await (await app.get(`/api/v1/resources/${row.id}`)).json()).url).toBe('https://src/x')
  })

  // TODO(legacy-mongo-ids): drop this case when legacy ids are retired.
  it('looks up a legacy MongoDB ObjectId (24 hex chars)', async () => {
    const app = await loadApp()
    const row = await insertResource({ legacy_mongo_id: '65a1b2c3d4e5f6a7b8c9d0e1' })
    const res = await app.get('/api/v1/resources/65a1b2c3d4e5f6a7b8c9d0e1')
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe(row.id)
  })

  it('returns 404 for an unknown id', async () => {
    const app = await loadApp()
    for (const id of ['00000000-0000-4000-8000-000000000000', 'aaaaaaaaaaaaaaaaaaaaaaaa']) {
      const res = await app.get(`/api/v1/resources/${id}`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found' })
    }
  })

  it('returns 404 for an inactive resource', async () => {
    const app = await loadApp()
    const row = await insertResource({ is_active: false })
    expect((await app.get(`/api/v1/resources/${row.id}`)).status).toBe(404)
  })

  it.each(['not-a-uuid', '123', 'python-for-everybody', '65a1b2c3d4e5f6a7b8c9d0e1z'])(
    'returns 404 (not 500) for an id that is neither a UUID nor an ObjectId: %s',
    async id => {
      const app = await loadApp()
      const res = await app.get(`/api/v1/resources/${id}`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found' })
    },
  )
})
