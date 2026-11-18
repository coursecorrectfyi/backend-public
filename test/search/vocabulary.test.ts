/** src/search/vocabulary.ts: the vocabulary refresh and typo correction (PGlite). */
import { beforeEach, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { db, resetDb } from '../fakes/db.js'
import { insertResource } from '../helpers/fixtures.js'
import { learning_resources, search_vocabulary } from '../../src/db/schema.js'
import { SEARCH_CONFIG, type SearchConfig } from '../../src/search/config.js'
import { correctTypos, refreshVocabulary } from '../../src/search/vocabulary.js'

beforeEach(resetDb)

const vocabulary = async () =>
  Object.fromEntries((await db.select().from(search_vocabulary).orderBy(asc(search_vocabulary.word))).map(r => [r.word, r.doc_count]))

/** Sets the vocabulary directly, to control words and frequencies exactly. */
const setVocabulary = async (words: Record<string, number>) => {
  await db.delete(search_vocabulary)
  await db.insert(search_vocabulary).values(Object.entries(words).map(([word, doc_count]) => ({ word, doc_count })))
}

const correct = (query: string, config: SearchConfig = SEARCH_CONFIG) => correctTypos(db, query, config)

describe('refreshVocabulary', () => {
  it('counts every word of the active catalogue text, in how many resources it appears', async () => {
    await insertResource({ title: 'Python Basics', ai_summary: 'Learn Python fast.', skills: ['Pandas'], institution: 'Université Lyon' })
    await insertResource({ title: 'Python 3 Advanced', ai_summary: 'An ok course.' })
    await insertResource({ title: 'Secretword', is_active: false })
    expect(await refreshVocabulary(db)).toEqual({ words: 9 })
    // python is in both resources (counted once per resource); "3" has a digit; "an" and "ok" are too short;
    // the inactive resource's words are left out.
    expect(await vocabulary()).toEqual({
      advanced: 1, basics: 1, course: 1, fast: 1, learn: 1, lyon: 1, pandas: 1, python: 2, université: 1,
    })
  })

  it('replaces the previous vocabulary entirely', async () => {
    const a = await insertResource({ title: 'Python Basics' })
    await insertResource({ title: 'Python Advanced' })
    await refreshVocabulary(db)
    await db.update(learning_resources).set({ is_active: false }).where(eq(learning_resources.id, a.id))
    await refreshVocabulary(db)
    expect(await vocabulary()).toEqual({ advanced: 1, python: 1 })
  })
})

describe('correctTypos', () => {
  it('does nothing before the vocabulary is built (every word would look unknown)', async () => {
    expect(await correct('pyhton')).toBeNull()
  })

  it('leaves known words alone, however rare', async () => {
    await setVocabulary({ python: 100, pythonic: 1 })
    expect(await correct('python pythonic')).toBeNull()
  })

  it.each([
    ['pyhton', 'python'], // swapped letters: found by first letter and length (trigrams miss it)
    ['kython', 'python'], // wrong first letter: found by trigrams
    ['pytho', 'python'], // missing letter
    ['pythoon', 'python'], // extra letter
    ['javscript', 'javascript'],
  ])('corrects an unknown word: %s → %s', async (typo, word) => {
    await setVocabulary({ python: 100, javascript: 50, typhoon: 3 })
    expect(await correct(typo)).toBe(word)
  })

  it('keeps the rest of the query as typed, replacing every occurrence of the word', async () => {
    await setVocabulary({ python: 100, basics: 10 })
    expect(await correct('Pyhton basics, PYHTON!')).toBe('python basics, python!')
  })

  it('corrects several words', async () => {
    await setVocabulary({ machine: 10, learning: 10 })
    expect(await correct('machne lerning')).toBe('machine learning')
  })

  it('never corrects short words or words with digits', async () => {
    await setVocabulary({ sql: 100, java: 100, python3: 1, python: 100 })
    expect(await correct('sqll')).toBe('sql') // 4 letters: corrected...
    expect(await correct('sq')).toBeNull() // ...but not below the minimum length
    expect(await correct('jav')).toBeNull()
    expect(await correct('pyth0n')).toBeNull()
  })

  it('leaves a word alone when nothing is close enough', async () => {
    await setVocabulary({ python: 100 })
    expect(await correct('blockchain')).toBeNull()
    expect(await correct('pxtxxn')).toBeNull() // 3 edits from python: over the limit (2 for 6+ letters)
    expect(await correct('pxtxon')).toBe('python') // 2 edits: within it
  })

  it('prefers the closest word, then the most frequent, then alphabetical order', async () => {
    await setVocabulary({ abcdeg: 1, abcdgg: 100 })
    expect(await correct('abcdef')).toBe('abcdeg') // 1 edit beats 2, whatever the frequency
    await setVocabulary({ abcdeg: 1, abcdeh: 50 })
    expect(await correct('abcdef')).toBe('abcdeh') // same distance: the more frequent
    await setVocabulary({ abcdeh: 5, abcdeg: 5 })
    expect(await correct('abcdef')).toBe('abcdeg') // same distance and frequency: alphabetical
  })

  it('only corrects to words in at least minDocCount resources', async () => {
    await setVocabulary({ abcdeg: 1, abcdeh: 50 })
    const strict: SearchConfig = { ...SEARCH_CONFIG, typos: { ...SEARCH_CONFIG.typos, minDocCount: 60 } }
    expect(await correct('abcdef', strict)).toBeNull()
  })
})
