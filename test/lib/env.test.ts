/** src/lib/env.ts: strict integer settings from the environment. */
import { describe, expect, it, vi } from 'vitest'
import { readNonNegativeIntEnv } from '../../src/lib/env.js'

describe('readNonNegativeIntEnv', () => {
  it.each([[undefined], [''], ['   ']])('uses the default when the value is %j', value => {
    vi.stubEnv('TEST_INT', value)
    expect(readNonNegativeIntEnv('TEST_INT', 7)).toBe(7)
  })

  it.each([['0', 0], ['20', 20], [' 5 ', 5], ['1000000', 1_000_000]])('reads %j as %d', (value, expected) => {
    vi.stubEnv('TEST_INT', value)
    expect(readNonNegativeIntEnv('TEST_INT', 7)).toBe(expected)
  })

  it.each(['-1', '1.5', 'abc', '1e3', '0x10', '20 questions'])('throws for %j, naming the variable', value => {
    vi.stubEnv('TEST_INT', value)
    expect(() => readNonNegativeIntEnv('TEST_INT', 7)).toThrow(`TEST_INT must be a non-negative integer, got "${value}"`)
  })
})
