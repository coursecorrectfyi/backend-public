/** src/lib/embedding/query-cache.ts: bounded in-memory cache of query embeddings. */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_ENTRIES, QueryEmbeddingCache } from '../../src/lib/embedding/query-cache.js'

/** An embed function that returns [length of text, call number], and counts calls per text. */
function fakeEmbed() {
  let calls = 0
  return vi.fn(async (text: string) => [text.length, ++calls])
}

describe('QueryEmbeddingCache', () => {
  it('calls the API once per text and returns the cached vector afterwards', async () => {
    const embed = fakeEmbed()
    const cache = new QueryEmbeddingCache(embed)
    const first = await cache.get('learn python')
    const again = await cache.get('learn python')
    expect(embed).toHaveBeenCalledTimes(1)
    expect(again).toBe(first)
    await cache.get('learn sql')
    expect(embed).toHaveBeenCalledTimes(2)
  })

  it('stores vectors as Float32Array (more precision than the halfvec column keeps)', async () => {
    const cache = new QueryEmbeddingCache(async () => [0.1, 0.2, 0.3])
    const vector = await cache.get('x')
    expect(vector).toBeInstanceOf(Float32Array)
    expect(Array.from(vector)).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)])
  })

  it('has() tells whether get() would be answered without calling the API', async () => {
    const embed = fakeEmbed()
    const cache = new QueryEmbeddingCache(embed)
    expect(cache.has('learn python')).toBe(false)
    const pending = cache.get('learn python')
    expect(cache.has('learn python')).toBe(true) // pending counts: get() would share it
    await pending
    expect(cache.has('learn python')).toBe(true)
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('has() forgets a failed call (the next get() tries the API again)', async () => {
    const cache = new QueryEmbeddingCache(async () => { throw new Error('503') })
    await expect(cache.get('x')).rejects.toThrow('503')
    expect(cache.has('x')).toBe(false)
  })

  it('has() does not count as a use for eviction', async () => {
    const cache = new QueryEmbeddingCache(fakeEmbed(), { maxEntries: 2 })
    await cache.get('a')
    await cache.get('b')
    cache.has('a')
    await cache.get('c') // evicts the least recently used: still 'a'
    expect([cache.has('a'), cache.has('b'), cache.has('c')]).toEqual([false, true, true])
  })

  it('shares one API call between identical requests arriving together', async () => {
    let resolve!: (v: number[]) => void
    const embed = vi.fn(() => new Promise<number[]>(r => { resolve = r }))
    const cache = new QueryEmbeddingCache(embed)
    const a = cache.get('popular')
    const b = cache.get('popular')
    resolve([1, 2])
    expect(await a).toBe(await b)
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('does not keep failures: the next request calls the API again', async () => {
    const embed = vi.fn<(text: string) => Promise<number[]>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([1])
    const cache = new QueryEmbeddingCache(embed)
    await expect(cache.get('q')).rejects.toThrow('timeout')
    expect(cache.size).toBe(0)
    expect(Array.from(await cache.get('q'))).toEqual([1])
    expect(embed).toHaveBeenCalledTimes(2)
  })

  it('passes a failure to every request that was waiting for it', async () => {
    let reject!: (e: Error) => void
    const cache = new QueryEmbeddingCache(() => new Promise<number[]>((_, r) => { reject = r }))
    const a = cache.get('q')
    const b = cache.get('q')
    reject(new Error('down'))
    await expect(a).rejects.toThrow('down')
    await expect(b).rejects.toThrow('down')
  })

  it('keeps at most maxEntries, dropping the least recently used', async () => {
    const embed = fakeEmbed()
    const cache = new QueryEmbeddingCache(embed, { maxEntries: 2 })
    await cache.get('a')
    await cache.get('b')
    await cache.get('a') // 'a' is now the most recently used; 'b' the least
    await cache.get('c') // evicts 'b'
    expect(cache.size).toBe(2)
    embed.mockClear()
    await cache.get('a')
    await cache.get('c')
    expect(embed).not.toHaveBeenCalled()
    await cache.get('b')
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('stays bounded under a flood of unique queries (they can only evict, not grow the cache)', async () => {
    const cache = new QueryEmbeddingCache(fakeEmbed(), { maxEntries: 100 })
    for (let i = 0; i < 5_000; i++) await cache.get(`unique query ${i}`)
    expect(cache.size).toBe(100)
  })

  it('does not let an old failure remove a newer entry for the same text', async () => {
    const rejects: Array<(e: Error) => void> = []
    const embed = vi.fn<(text: string) => Promise<number[]>>()
      .mockImplementationOnce(() => new Promise((_, r) => { rejects.push(r) }))
      .mockResolvedValue([7])
    const cache = new QueryEmbeddingCache(embed, { maxEntries: 1 })
    const stale = cache.get('q') // pending
    await cache.get('other') // evicts the pending 'q'
    await cache.get('q') // a new, successful entry for 'q' ('other' evicted)
    rejects[0]!(new Error('late failure'))
    await expect(stale).rejects.toThrow('late failure')
    expect(Array.from(await cache.get('q'))).toEqual([7])
    expect(embed).toHaveBeenCalledTimes(3)
  })

  it('defaults to 2,000 entries (about 7 MB), and clear() empties it', async () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(2_000)
    const cache = new QueryEmbeddingCache(fakeEmbed())
    await cache.get('a')
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
