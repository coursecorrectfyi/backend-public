/** src/lib/rate-limit.ts: in-memory token bucket ("N per minute, bursts up to N"). */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_KEYS, RateLimiter } from '../../src/lib/rate-limit.js'

/** A limiter on a clock the test moves by hand. */
function limiterAt(start = 1_000_000, maxKeys?: number) {
  let now = start
  const limiter = new RateLimiter({ now: () => now, maxKeys })
  return {
    limiter,
    advance(ms: number) { now += ms },
    setTime(ms: number) { now = ms },
    /** Takes `n` tokens and returns how many were allowed. */
    takeMany(key: string, perMinute: number, n: number) {
      let allowed = 0
      for (let i = 0; i < n; i++) if (limiter.take(key, perMinute).allowed) allowed++
      return allowed
    },
  }
}

describe('RateLimiter', () => {
  it('allows a burst of N, then limits', () => {
    const { limiter, takeMany } = limiterAt()
    expect(takeMany('a', 10, 10)).toBe(10)
    expect(limiter.take('a', 10)).toEqual({ allowed: false, retryAfterSeconds: 6 }) // one token per 6 s
  })

  it('refills continuously at N per minute', () => {
    const { limiter, takeMany, advance } = limiterAt()
    takeMany('a', 60, 60)
    expect(limiter.take('a', 60).allowed).toBe(false)
    advance(999)
    expect(limiter.take('a', 60).allowed).toBe(false)
    advance(1)
    expect(limiter.take('a', 60).allowed).toBe(true) // 1 token per second
    expect(limiter.take('a', 60).allowed).toBe(false)
  })

  it('never refills beyond N, however long the client was idle', () => {
    const { takeMany, advance } = limiterAt()
    takeMany('a', 10, 10)
    advance(60 * 60_000)
    expect(takeMany('a', 10, 15)).toBe(10)
  })

  it('lets a client that stays under N per minute through indefinitely', () => {
    const { limiter, advance } = limiterAt()
    for (let i = 0; i < 100; i++) {
      expect(limiter.take('a', 20).allowed).toBe(true)
      advance(3_000) // exactly 20 per minute
    }
  })

  it('does not use up tokens on requests over the limit, so a client that waits Retry-After gets through', () => {
    const { limiter, takeMany, advance } = limiterAt()
    takeMany('a', 10, 10)
    for (let i = 0; i < 50; i++) expect(limiter.take('a', 10).allowed).toBe(false)
    const result = limiter.take('a', 10)
    expect(result.allowed).toBe(false)
    advance((result as { retryAfterSeconds: number }).retryAfterSeconds * 1000)
    expect(limiter.take('a', 10).allowed).toBe(true)
  })

  it('rounds Retry-After up to whole seconds, and never below 1', () => {
    const { limiter, takeMany, advance } = limiterAt()
    takeMany('a', 7, 7) // one token per 8.57 s
    expect(limiter.take('a', 7)).toEqual({ allowed: false, retryAfterSeconds: 9 })
    advance(8_500)
    expect(limiter.take('a', 7)).toEqual({ allowed: false, retryAfterSeconds: 1 })
    takeMany('b', 600, 600) // one token per 0.1 s
    expect(limiter.take('b', 600)).toEqual({ allowed: false, retryAfterSeconds: 1 })
  })

  it('keeps keys independent', () => {
    const { limiter, takeMany } = limiterAt()
    takeMany('a', 5, 5)
    expect(limiter.take('a', 5).allowed).toBe(false)
    expect(limiter.take('b', 5).allowed).toBe(true)
  })

  it('does not drain a bucket when the clock steps backwards', () => {
    const { limiter, takeMany, setTime } = limiterAt(1_000_000)
    takeMany('a', 10, 5)
    setTime(500_000)
    expect(takeMany('a', 10, 10)).toBe(5) // the 5 tokens that were left, no more and no fewer
    expect(limiter.take('a', 10).allowed).toBe(false)
  })

  describe('memory bound', () => {
    it('defaults to 50,000 keys', () => {
      expect(DEFAULT_MAX_KEYS).toBe(50_000)
    })

    it('keeps at most maxKeys buckets, dropping the least recently used', () => {
      const { limiter, takeMany } = limiterAt(0, 3)
      takeMany('a', 2, 2)
      takeMany('b', 2, 2)
      takeMany('c', 2, 2)
      limiter.take('a', 2) // 'a' is now the most recently used; 'b' the least
      limiter.take('d', 2)
      expect(limiter.size).toBe(3)
      expect(limiter.take('a', 2).allowed).toBe(false) // kept: still empty
      expect(limiter.take('c', 2).allowed).toBe(false) // kept
      expect(limiter.take('b', 2).allowed).toBe(true) // dropped, so it starts full again
    })

    it('stays bounded when many clients appear', () => {
      const { limiter } = limiterAt(0, 100)
      for (let i = 0; i < 10_000; i++) limiter.take(`client-${i}`, 10)
      expect(limiter.size).toBe(100)
    })
  })

  it('clear() forgets every bucket', () => {
    const { limiter, takeMany } = limiterAt()
    takeMany('a', 1, 1)
    limiter.clear()
    expect(limiter.size).toBe(0)
    expect(limiter.take('a', 1).allowed).toBe(true)
  })

  it('uses the real clock by default', () => {
    const limiter = new RateLimiter()
    expect(limiter.take('a', 1).allowed).toBe(true)
    expect(limiter.take('a', 1)).toEqual({ allowed: false, retryAfterSeconds: 60 })
  })
})
