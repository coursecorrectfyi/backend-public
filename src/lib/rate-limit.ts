/**
 * In-memory token-bucket rate limiter ("N per minute, bursts up to N").
 *
 * Each key (e.g. route group + client IP) has a bucket of N tokens that
 * refills continuously at N per minute. A request takes one token, or is over
 * the limit when less than one is left. A client that stays under N per minute
 * is never limited, and one that bursts can send N at once and then one every
 * 60/N seconds. Requests over the limit don't use up tokens, so a client that
 * backs off gets through again as soon as Retry-After says.
 *
 * Memory is bounded: at most `maxKeys` buckets are kept, and the least
 * recently used one is dropped to make room. Dropping a bucket only resets
 * that key's count (it starts full again). A full bucket behaves exactly like
 * a missing one, so for the usual case (an idle client) nothing is lost.
 *
 * State is per process. On Cloud Run each instance counts separately, so a
 * client whose requests are spread over K instances can get up to K × N per
 * minute. See docs/deployment-gcp.md §6.
 */

/** Enough for tens of thousands of active clients in a few MB. */
export const DEFAULT_MAX_KEYS = 50_000

export type TakeResult =
  | { allowed: true }
  | { allowed: false; /** Whole seconds until a token is available (at least 1). */ retryAfterSeconds: number }

interface Bucket {
  tokens: number
  updatedAt: number
}

export class RateLimiter {
  // Map keeps insertion order: re-inserting on every use keeps the least
  // recently used bucket first, which is the one evicted.
  private readonly buckets = new Map<string, Bucket>()
  private readonly maxKeys: number
  private readonly now: () => number

  constructor(options: { maxKeys?: number; now?: () => number } = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
    this.now = options.now ?? (() => Date.now())
  }

  /** Takes one token from `key`'s bucket of `perMinute` (must be > 0). */
  take(key: string, perMinute: number): TakeResult {
    const now = this.now()
    const refillPerMs = perMinute / 60_000

    let tokens = perMinute
    const bucket = this.buckets.get(key)
    if (bucket) {
      // Math.max: a clock that steps backwards must not drain the bucket.
      tokens = Math.min(perMinute, bucket.tokens + Math.max(0, now - bucket.updatedAt) * refillPerMs)
      this.buckets.delete(key)
    }

    const allowed = tokens >= 1
    if (allowed) tokens -= 1
    this.buckets.set(key, { tokens, updatedAt: now })
    if (this.buckets.size > this.maxKeys) {
      this.buckets.delete(this.buckets.keys().next().value!)
    }

    if (allowed) return { allowed: true }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)) }
  }

  /** Number of buckets held. */
  get size(): number {
    return this.buckets.size
  }

  clear(): void {
    this.buckets.clear()
  }
}
