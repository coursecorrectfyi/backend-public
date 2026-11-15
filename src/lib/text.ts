/**
 * Cuts `text` to at most `maxChars` UTF-16 code units (String.length, the
 * unit of the HTML maxlength attribute) without splitting a surrogate pair:
 * an emoji cut in half would become an invalid character.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = maxChars
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1 // high surrogate: its pair is past the cut
  return text.slice(0, end)
}

/** Collapses every run of whitespace (including line breaks) into one space, and trims. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Like truncate, but doesn't leave half a word at the end: the cut moves back
 * to the last whitespace. Keyword search needs every word of the query to
 * match, so a fragment like "fil" (from "filler") would match nothing and
 * empty the results. Text without whitespace before the limit is cut hard.
 */
export function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = truncate(text, maxChars)
  if (/\s/.test(text.charAt(cut.length))) return cut.trimEnd() // the cut fell between words
  const lastSpace = cut.search(/\s\S*$/)
  return lastSpace > 0 ? cut.slice(0, lastSpace).trimEnd() : cut
}
