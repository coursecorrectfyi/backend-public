/** src/lib/env.ts: strict integer settings from the environment. */
import { describe, expect, it, vi } from 'vitest'
import { readEnumEnv, readNonNegativeIntEnv } from '../../src/lib/env.js'

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

describe('readEnumEnv', () => {
  const MODES = ['enforce', 'shadow'] as const

  it.each([[undefined], [''], ['   ']])('uses the default when the value is %j', value => {
    vi.stubEnv('TEST_MODE', value)
    expect(readEnumEnv('TEST_MODE', MODES, 'enforce')).toBe('enforce')
  })

  it.each([['shadow', 'shadow'], [' enforce ', 'enforce'], ['SHADOW', 'shadow']])('reads %j as %j', (value, expected) => {
    vi.stubEnv('TEST_MODE', value)
    expect(readEnumEnv('TEST_MODE', MODES, 'enforce')).toBe(expected)
  })

  it.each(['off', 'true', 'shadow mode', '0'])('throws for %j, naming the variable and the allowed values', value => {
    vi.stubEnv('TEST_MODE', value)
    expect(() => readEnumEnv('TEST_MODE', MODES, 'enforce'))
      .toThrow(`TEST_MODE must be one of enforce, shadow, got "${value}"`)
  })
})
