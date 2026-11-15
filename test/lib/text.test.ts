/** src/lib/text.ts: length and whitespace helpers shared by chat and search input. */
import { describe, expect, it } from 'vitest'
import { collapseWhitespace, truncate, truncateAtWord } from '../../src/lib/text.js'

describe('truncate', () => {
  it('returns text at or under the limit unchanged', () => {
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('', 0)).toBe('')
  })

  it('cuts text over the limit', () => {
    expect(truncate('abcdef', 4)).toBe('abcd')
  })

  it('does not split a surrogate pair (emoji) at the cut', () => {
    // '😀' is two UTF-16 code units; a cut after its first unit drops the whole emoji
    expect(truncate('ab😀cd', 3)).toBe('ab')
    expect(truncate('ab😀cd', 4)).toBe('ab😀')
  })
})

describe('collapseWhitespace', () => {
  it.each([
    ['  a  b  ', 'a b'],
    ['a\n\tb\r\n c', 'a b c'],
    ['   ', ''],
    ['a\u00a0b', 'a b'], // non-breaking space counts as whitespace
  ])('%j -> %j', (input, expected) => {
    expect(collapseWhitespace(input)).toBe(expected)
  })
})

describe('truncateAtWord', () => {
  it.each([
    ['learn python', 20, 'learn python'], // short enough: unchanged
    ['learn python fast', 12, 'learn python'], // the cut falls exactly between words
    ['learn python fast', 14, 'learn python'], // "fa" would be half a word: dropped
    ['learn python fast', 13, 'learn python'], // cut right after the space
    ['supercalifragilistic', 5, 'super'], // no space before the limit: hard cut
    ['ab 😀😀', 5, 'ab'], // never half a word, never half an emoji
  ])('%j at %d -> %j', (text, max, expected) => {
    expect(truncateAtWord(text, max)).toBe(expected)
  })
})
