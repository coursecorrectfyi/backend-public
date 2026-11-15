/**
 * In-memory cache of search-query embeddings, so paging through results (and
 * repeating a popular search) doesn't call the embedding API again for the
 * same text.
 *
 * - Keyed by the exact text that is embedded. Search normalizes and caps the
 *   query first (at most 200 characters), so keys are small.
 * - Least recently used entries are dropped beyond `maxEntries`: memory is
 *   bounded whatever the traffic. A vector is 768 × 4 bytes as a Float32Array
 *   (pgvector stores float4, so nothing is lost), about 3.5 KB per entry with
 *   its key: 2,000 entries ≈ 7 MB. A flood of unique queries can only evict
 *   useful entries, not grow the cache.
 * - No expiry: the same model always returns the same vector, and changing the
 *   model means a deploy, which starts with an empty cache.
 * - Identical requests arriving together share one API call (the pending
 *   promise is cached). Failures are not cached: the next request tries again.
 * - Per process: each Cloud Run instance has its own cache.
 */

export const DEFAULT_MAX_ENTRIES = 2_000

export class QueryEmbeddingCache {
  private readonly entries = new Map<string, Promise<Float32Array>>()
  private readonly maxEntries: number

  constructor(
    private readonly embed: (text: string) => Promise<ArrayLike<number>>,
    options: { maxEntries?: number } = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /** The embedding of `text`, from the cache or the embedding API. */
  get(text: string): Promise<Float32Array> {
    const cached = this.entries.get(text)
    if (cached) {
      // Move to the most recently used end (Map keeps insertion order).
      this.entries.delete(text)
      this.entries.set(text, cached)
      return cached
    }

    const pending = this.embed(text).then(values => Float32Array.from(values))
    this.entries.set(text, pending)
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!)
    }
    pending.catch(() => {
      // Don't keep a failure (unless a newer request already replaced it).
      if (this.entries.get(text) === pending) this.entries.delete(text)
    })
    return pending
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
