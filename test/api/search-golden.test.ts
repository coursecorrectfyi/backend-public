/**
 * Search golden set: queries with known good answers over a small realistic
 * catalogue (test/helpers/search-catalogue.ts), checked through the real API.
 *
 * What this covers, and what it can't:
 * - It pins down *behaviour*: which resources come back, roughly where, with
 *   filters, sorts, pagination and an embedding outage. Assertions are about
 *   positions ("in the top 3", "above X"), not exact orders, so tuning the
 *   ranking doesn't break them without a reason.
 * - Semantic similarity comes from a fake embedding with a fixed list of
 *   concepts, not the real model. How good the real ranking is can only be
 *   measured on the real catalogue with real embeddings (docs/backlog.md,
 *   "Measure first"), not here.
 *
 * Known problems are written as `it.fails` with a KNOWN BUG comment (see the
 * README): they report "expected fail" until fixed, then fail to remind you to
 * turn them into `it`. The first group must keep passing throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadApp, type TestClient } from '../helpers/app.js'
import { pg, resetDb } from '../fakes/db.js'
import { embedQuery } from '../fakes/embedding.js'
import { CATALOGUE, conceptEmbedding, conceptsOf, insertCatalogue } from '../helpers/search-catalogue.js'
import { insertResource } from '../helpers/fixtures.js'

beforeEach(async () => {
  await resetDb()
  // The fake model embeds queries the same way as the catalogue.
  embedQuery.mockImplementation(async (text: string) => conceptEmbedding(text))
})

interface SearchBody { data: Array<Record<string, any>>; next_cursor: string | null; vector_search: boolean; corrected_query: string | null }

async function search(app: TestClient, params: string): Promise<SearchBody> {
  const res = await app.get(`/api/v1/resources/search?${params}`)
  expect(res.status).toBe(200)
  return res.json()
}

async function titlesFor(app: TestClient, params: string): Promise<string[]> {
  return (await search(app, params)).data.map(r => r.title as string)
}

const q = (text: string) => `q=${encodeURIComponent(text)}`

/** 1-based position of `title` in `titles`, or Infinity if it's missing. */
const rankOf = (titles: string[], title: string) => {
  const i = titles.indexOf(title)
  return i === -1 ? Infinity : i + 1
}

describe('search golden set: the fixture', () => {
  it('every resource mentions at least one concept the fake embedding knows', () => {
    for (const { title, ai_summary, skills } of CATALOGUE) {
      expect(conceptsOf([title, ai_summary, ...(skills ?? [])].join(' ')), title).not.toEqual([])
    }
  })
})

describe('search golden set: works today, must keep working', () => {
  it.each([
    ['python', ['Python for Everybody', 'Python for Data Analysis', 'Complete Python Bootcamp: Zero to Hero'], 5],
    ['machine learning', ['Machine Learning Specialization'], 1],
    ['google project management', ['Google Project Management: Professional Certificate'], 1],
    ['kubernetes', ['Kubernetes for Absolute Beginners'], 1],
    ['excel', ['Excel Skills for Business', 'Data Analysis with Excel'], 2],
    ['photoshop', ['Adobe Photoshop Essentials'], 1],
    ['react', ['React - The Complete Guide'], 2],
    ['sql data analysis', ['SQL for Data Analysts'], 1],
    ['Python for Data Analysis', ['Python for Data Analysis'], 1], // an exact title
    // A typo the English stemmer happens to absorb: both words stem to "kubernet".
    ['kubernets', ['Kubernetes for Absolute Beginners'], 1],
  ])('"%s" has %j in the top %i', async (text, expected, topN) => {
    const app = await loadApp()
    await insertCatalogue()
    const top = (await titlesFor(app, q(text))).slice(0, topN)
    for (const title of expected) expect(top, `${title} in ${JSON.stringify(top)}`).toContain(title)
  })

  it('finds nothing for nonsense (semantic search must not fill the page with its nearest neighbours)', async () => {
    const app = await loadApp()
    await insertCatalogue()
    expect(await titlesFor(app, q('qwxzv blorft'))).toEqual([])
  })

  it('answers a query of stop words only with 200', async () => {
    const app = await loadApp()
    await insertCatalogue()
    await search(app, q('how to'))
  })

  it('applies filters to every result', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const body = await search(app, `${q('python')}&provider=coursera&level=beginner`)
    expect(body.data.length).toBeGreaterThan(0)
    for (const r of body.data) expect([r.provider, r.level]).toEqual(['coursera', 'beginner'])
  })

  // Passes today only because every word has to match, so nothing else comes
  // back. Once any word can match, other Python courses compete, and a resource
  // without an embedding is missing from the semantic list: in plain rank
  // fusion it can never beat a resource ranked high in both lists.
  it('ranks an exact title match first, even before the embedding job has run for it', async () => {
    const app = await loadApp()
    await insertCatalogue()
    expect((await titlesFor(app, q('python crash course')))[0]).toBe('Python Crash Course')
  })

  it('keeps a resource whose text matches but that has no embedding yet', async () => {
    const app = await loadApp()
    await insertCatalogue()
    expect(await titlesFor(app, q('python'))).toContain('Python Crash Course')
  })
})

describe('search golden set: natural-language queries', () => {
  // Used to return nothing: every word had to match, and "best", "course" and
  // "beginners" don't appear in the resource. Now generic words are ignored,
  // any word can match, and semantic matches count too.
  it('"best python course for data analysis beginners" has Python for Data Analysis in the top 3', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const titles = await titlesFor(app, q('best python course for data analysis beginners'))
    expect(rankOf(titles, 'Python for Data Analysis')).toBeLessThanOrEqual(3)
  })

  // Matching any word needs a ranking that weighs rare words above common ones:
  // ts_rank alone doesn't, so a resource repeating "best course for beginners"
  // would win. Generic words are ignored, and coverage ranks first.
  it('a resource sharing only generic words with the query ranks below real matches', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const titles = await titlesFor(app, q('best python course for data analysis beginners'))
    expect(rankOf(titles, 'Python for Data Analysis')).toBeLessThan(rankOf(titles, 'The Best Course for Beginners: Start Here'))
  })

  // "learn" doesn't appear in the resource: all-words matching alone found nothing.
  it('"learn to build websites" has The Complete Web Development Bootcamp in the top 3', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const titles = await titlesFor(app, q('learn to build websites'))
    expect(rankOf(titles, 'The Complete Web Development Bootcamp')).toBeLessThanOrEqual(3)
  })

  // Semantic similarity used to only re-rank keyword matches; now it adds results.
  it('"how to make a website" finds the web courses through semantic similarity', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const titles = (await titlesFor(app, q('how to make a website'))).slice(0, 3)
    expect(titles).toEqual(expect.arrayContaining([
      'WordPress for Beginners: Create a Website', 'The Complete Web Development Bootcamp',
    ]))
  })

  // Filters apply to semantic matches too (inside the HNSW scan).
  it('semantic matches respect filters', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const body = await search(app, `${q('how to make a website')}&provider=udemy`)
    expect(body.data.map(r => r.title)).toContain('The Complete Web Development Bootcamp')
    for (const r of body.data) expect(r.provider).toBe('udemy')
  })
})

describe('search golden set: typos', () => {
  // The fake embedding doesn't know the typo either, so this needs the typo
  // correction (vocabulary). "pyhton" is a transposition: trigram similarity to
  // "python" is only 0.27, below pg_trgm's default threshold of 0.3, so the
  // same-first-letter lookup finds it.
  it('"pyhton" finds the Python courses', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const top = (await titlesFor(app, q('pyhton'))).slice(0, 3)
    expect(top.length).toBe(3)
    for (const title of top) expect(title).toMatch(/python/i)
  })

  // Two edits (h and y swapped around the t): allowed from 6 letters.
  it('"phyton" finds the Python courses', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const body = await search(app, q('phyton'))
    expect(body.corrected_query).toBe('python')
    for (const title of body.data.slice(0, 3).map(r => r.title)) expect(title).toMatch(/python/i)
  })

  // A letter missing in each word.
  it('"machne lerning" finds Machine Learning Specialization first', async () => {
    const app = await loadApp()
    await insertCatalogue()
    expect((await titlesFor(app, q('machne lerning')))[0]).toBe('Machine Learning Specialization')
  })

  // One missing letter.
  it('"photoshp" finds Adobe Photoshop Essentials first', async () => {
    const app = await loadApp()
    await insertCatalogue()
    expect((await titlesFor(app, q('photoshp')))[0]).toBe('Adobe Photoshop Essentials')
  })

  it('reports the correction, so the frontend can say "Showing results for python"', async () => {
    const app = await loadApp()
    await insertCatalogue()
    expect((await search(app, q('Pyhton basics'))).corrected_query).toBe('python basics')
    expect((await search(app, q('python basics'))).corrected_query).toBeNull()
  })

  it('leaves a word alone that the catalogue does not have and that is not close to any word it has', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const body = await search(app, q('blockchain'))
    expect(body.corrected_query).toBeNull()
    expect(body.data).toEqual([])
  })

  // The trade-off of typo tolerance, pinned down so changing it is deliberate: a
  // real word the catalogue lacks can be corrected to a close word it has
  // (2 edits are allowed from 6 letters, or "phyton" → "python" wouldn't work).
  // corrected_query lets the frontend say so. Tuning: docs/search.md.
  it('may correct a real word the catalogue lacks to a close one, and says so: "tableau" → "tables"', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const body = await search(app, q('tableau'))
    expect(body.corrected_query).toBe('tables')
    expect(body.data.map(r => r.title)).toContain('Data Analysis with Excel') // pivot tables
  })

  it('never corrects a word the catalogue has, however rare ("redux" appears once, near "reduce")', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const body = await search(app, q('redux'))
    expect(body.corrected_query).toBeNull()
    expect(body.data.map(r => r.title)).toContain('React - The Complete Guide')
  })

  // With the embedding API down: the keyword side alone has to cope.
  it('"javscript" finds the JavaScript courses when the embedding API is down', async () => {
    const app = await loadApp()
    await insertCatalogue()
    embedQuery.mockRejectedValue(new Error('Vertex AI embedding API 503'))
    const titles = await titlesFor(app, q('javscript'))
    expect(titles).toContain('JavaScript: Understanding the Weird Parts')
  })
})

describe('search golden set: ranking signals', () => {
  // sort=rating used the raw average: one 5.0 rating beat 20,000 ratings averaging
  // 4.8. Now it's a weighted (Bayesian) rating.
  it('sort=rating puts a 4.8 from 20,000 ratings above a 5.0 from 1 rating', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const titles = await titlesFor(app, `${q('python')}&sort=rating`)
    expect(rankOf(titles, 'Complete Python Bootcamp: Zero to Hero')).toBeLessThan(rankOf(titles, 'Python Quick Tips'))
  })

})

describe('search golden set: pagination and ranking modes', () => {
  // The ranking mode ('hybrid' or 'keyword') is recorded in the cursor, and a
  // cursor always continues in its own mode:
  // - keyword cursor: keyword order, without calling the embedding API;
  // - hybrid cursor whose query embedding can't be computed: 503. The frontend
  //   retries "Load more" with the same cursor, which works once the embedding is back.
  // Either way, never a page that quietly skips or repeats results.

  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  const embeddingUp = () => embedQuery.mockImplementation(async (text: string) => conceptEmbedding(text))

  /** Follows next_cursor from `cursor` (or page 1) to the end; every page must be 200. */
  async function followPages(app: TestClient, params: string, pageSize: number, cursor: string | null = null) {
    const ids: string[] = []
    for (let n = 0; n < 50; n++) {
      const body = await search(app, `${params}&limit=${pageSize}${cursor ? `&cursor=${cursor}` : ''}`)
      ids.push(...body.data.map(r => r.id as string))
      cursor = body.next_cursor
      if (!cursor) return ids
    }
    throw new Error('pagination did not terminate')
  }

  async function anotherInstance() {
    const { resetInstanceState } = await import('../../src/lib/instance-state.js')
    resetInstanceState() // nothing in the query-embedding cache
  }

  // Used to fall back to keyword ranking on page 2 while comparing against the
  // hybrid score in the cursor, skipping or repeating results.
  it('a hybrid cursor whose embedding fails gets 503, and the same cursor works once the embedding is back', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const params = q('python')
    const all = (await search(app, `${params}&limit=50`)).data.map(r => r.id as string)

    const page1 = await search(app, `${params}&limit=2`)
    expect(page1.vector_search).toBe(true)
    expect(page1.data.map(r => r.id)).toEqual(all.slice(0, 2))

    await anotherInstance()
    embedQuery.mockRejectedValue(timeout())
    const failed = await app.get(`/api/v1/resources/search?${params}&limit=2&cursor=${page1.next_cursor}`)
    expect(failed.status).toBe(503)

    embeddingUp()
    const rest = await followPages(app, params, 2, page1.next_cursor)
    expect([...page1.data.map(r => r.id as string), ...rest]).toEqual(all)
  })

  // Used to rank page 2 with the embedding once it was back, while page 1 and
  // the cursor came from the keyword-only ranking.
  it('a keyword-only first page continues in keyword order, without calling the embedding API', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const params = q('python')
    embedQuery.mockRejectedValue(timeout())
    const allKeyword = (await search(app, `${params}&limit=50`)).data.map(r => r.id as string)
    const page1 = await search(app, `${params}&limit=2`)
    expect(page1.vector_search).toBe(false)

    embeddingUp()
    embedQuery.mockClear()
    const rest = await followPages(app, params, 2, page1.next_cursor)
    expect([...page1.data.map(r => r.id as string), ...rest]).toEqual(allKeyword)
    expect(embedQuery).not.toHaveBeenCalled()
  })

  // Works today because sort=rating never uses the embedding. Once the other
  // sorts re-sort the hybrid result set, the same rule as above applies to them.
  it('sort=rating that started keyword-only continues keyword-only when the embedding comes back', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const params = `${q('python')}&sort=rating`
    embedQuery.mockRejectedValue(timeout())
    const allKeyword = (await search(app, `${params}&limit=50`)).data.map(r => r.id as string)
    const page1 = await search(app, `${params}&limit=2`)
    expect(page1.vector_search).toBe(false)

    embeddingUp()
    const rest = await followPages(app, params, 2, page1.next_cursor)
    expect([...page1.data.map(r => r.id as string), ...rest]).toEqual(allKeyword)
  })

  // Cursors from before the ranking mode was recorded carry a score on another
  // scale. They must get exactly this 400: the frontend matches on the message
  // and offers "Reload results".
  it('a relevance cursor from before the ranking mode was recorded gets 400 Invalid cursor', async () => {
    const app = await loadApp()
    await insertCatalogue()
    const oldCursor = Buffer.from(JSON.stringify({
      sort: 'relevance', id: '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a60', score: 0.5,
    })).toString('base64url')
    const res = await app.get(`/api/v1/resources/search?${q('python')}&cursor=${oldCursor}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid cursor' })
  })
})

describe('search golden set: other sorts order the same results', () => {
  /** Every result of a search, over all pages. */
  async function allIds(app: TestClient, params: string): Promise<string[]> {
    const ids: string[] = []
    let cursor: string | null = null
    for (let n = 0; n < 20; n++) {
      const body = await search(app, `${params}&limit=50${cursor ? `&cursor=${cursor}` : ''}`)
      ids.push(...body.data.map(r => r.id as string))
      cursor = body.next_cursor
      if (!cursor) return ids
    }
    throw new Error('pagination did not terminate')
  }

  // Works today because both are "every word matches"; must stay true when
  // relevance also finds semantic and any-word matches.
  it.each(['rating', 'most_reviewed', 'duration_asc', 'duration_desc', 'newest'])(
    'sort=%s returns the same results as relevance, in another order', async sort => {
      const app = await loadApp()
      await insertCatalogue()
      for (const text of ['python', 'data analysis', 'learn to build websites']) {
        const relevance = await allIds(app, q(text))
        expect((await allIds(app, `${q(text)}&sort=${sort}`)).sort(), text).toEqual(relevance.sort())
      }
    },
  )

  // Used to be empty: every word had to match, so there was nothing to sort.
  it('sort=rating for a natural-language query is not empty', async () => {
    const app = await loadApp()
    await insertCatalogue()
    expect(await titlesFor(app, `${q('learn to build websites')}&sort=rating`))
      .toContain('The Complete Web Development Bootcamp')
  })
})

describe('search golden set: semantic retrieval through the HNSW index', () => {
  // These force the planner onto the indexes, as on the real catalogue: a small
  // table would otherwise be scanned sequentially, which is always exact and
  // hides the two pgvector pitfalls below.
  //
  // HNSW is approximate and its graph differs per build (random levels). These
  // stay deterministic because the search raises ef_search to 100, at least as
  // many rows as the first test has (45), and the iterative scan in the second
  // keeps going until it has looked at every row (120, far below
  // hnsw.max_scan_tuples). Keep it that way when changing them.
  beforeEach(async () => { await pg.exec('SET enable_seqscan = off') })
  afterEach(async () => { await pg.exec('RESET enable_seqscan') })

  /** `n` resources about web development, with no word in common with the query. */
  async function insertWebResources(n: number, overrides: (i: number) => Record<string, unknown> = () => ({})) {
    for (let i = 0; i < n; i++) {
      await insertResource({
        title: `Frontend Bootcamp ${i}`, ai_summary: 'HTML and CSS layouts',
        embedding: conceptEmbedding('web html css', i), ...overrides(i),
      })
    }
  }

  async function allTitles(app: TestClient, params: string): Promise<string[]> {
    const titles: string[] = []
    let cursor: string | null = null
    for (let n = 0; n < 20; n++) {
      const body = await search(app, `${params}&limit=50${cursor ? `&cursor=${cursor}` : ''}`)
      titles.push(...body.data.map(r => r.title as string))
      cursor = body.next_cursor
      if (!cursor) break
    }
    return titles
  }

  // pgvector's default hnsw.ef_search (40) silently caps an HNSW scan at 40
  // rows, so the search raises it to the number of semantic candidates.
  it('returns more than 40 semantic matches (hnsw.ef_search is raised)', async () => {
    const app = await loadApp()
    await insertWebResources(45)
    expect(await allTitles(app, q('how to make a website'))).toHaveLength(45)
  })

  // Taking the HNSW top-N and then filtering leaves nothing for a rare filter
  // value, unless the scan continues (pgvector iterative scans).
  it('finds semantic matches for a rare filter value', async () => {
    const app = await loadApp()
    await insertWebResources(120, i => ({ provider: i % 40 === 39 ? 'edx' : 'udemy' }))
    const titles = await allTitles(app, `${q('how to make a website')}&provider=edx`)
    expect(titles.sort()).toEqual(['Frontend Bootcamp 119', 'Frontend Bootcamp 39', 'Frontend Bootcamp 79'])
  })
})
