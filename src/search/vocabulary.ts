/**
 * Typo tolerance: replacing query words the catalogue doesn't contain with
 * the closest word it does contain.
 *
 * The vocabulary (search_vocabulary: every word in the active catalogue's
 * text, with how many resources contain it) is rebuilt by refreshVocabulary().
 * A query word that isn't in it matches no resource, so replacing it loses
 * nothing: "pyhton" → "python", "photoshp" → "photoshop". Known words are
 * never touched, even rare ones.
 *
 * Candidates come from two lookups: similar trigrams (pg_trgm), or the same
 * first letter and a similar length. Trigrams handle most typos but miss
 * swapped letters ("pyhton" shares only 3 of 11 trigrams with "python").
 * Among candidates within the allowed edit distance (Levenshtein), the closest
 * wins, then the most frequent, then alphabetical order (a total order: the
 * same query is always corrected the same way).
 *
 * The risk is a real word that the catalogue doesn't have being corrected to
 * a similar one it does have. The API returns `corrected_query`, so the
 * frontend can say "Showing results for …". Short words are never corrected
 * (config.ts, typos).
 */
import { sql } from 'drizzle-orm'
import { search_vocabulary } from '../db/schema.js'
import type { SearchConfig } from './config.js'
import type { Db } from './db.js'

/** Text that goes into the vocabulary: the searchable fields shown to users (like search_document, minus provider). */
const VOCABULARY_SOURCE = `
  SELECT to_tsvector('simple', concat_ws(' ', title, ai_summary, array_to_string(skills, ' '), institution))
  FROM learning_resources
  WHERE is_active`

/**
 * Rebuilds the vocabulary from the active catalogue, in one transaction
 * (searches keep using the previous vocabulary until it commits). Words of
 * 3–40 letters without digits. Takes a few seconds on the full catalogue.
 */
export async function refreshVocabulary(db: Db): Promise<{ words: number }> {
  return db.transaction(async tx => {
    await tx.delete(search_vocabulary)
    await tx.insert(search_vocabulary).select(
      tx.select({ word: sql<string>`s.word`.as('word'), doc_count: sql<number>`s.ndoc`.as('doc_count') })
        .from(sql`ts_stat(${VOCABULARY_SOURCE}) AS s`)
        .where(sql`length(s.word) BETWEEN 3 AND 40 AND s.word !~ '[0-9]'`),
    )
    const [{ words }] = await tx.select({ words: sql<number>`count(*)`.mapWith(Number) }).from(search_vocabulary) as [{ words: number }]
    return { words }
  })
}

/** Most edits allowed for a word of this length (config), or 0 if it's too short to correct. */
export function maxEditsFor(word: string, config: SearchConfig): number {
  const length = [...word].length
  if (length < config.typos.minWordLength) return 0
  let edits = 0
  for (const rule of config.typos.maxEdits) if (length >= rule.minLength) edits = rule.edits
  return edits
}

/**
 * The query with unknown words replaced by their closest vocabulary word, or
 * null if nothing was replaced (all words known, none close enough, or the
 * vocabulary hasn't been built yet).
 */
export async function correctTypos(db: Db, query: string, config: SearchConfig): Promise<string | null> {
  // The query's words as the vocabulary stores them ('simple': lowercase, unstemmed), and whether each is known.
  const words = await db
    .select({
      word: sql<string>`w.lexeme`,
      known: sql<boolean>`EXISTS (SELECT 1 FROM ${search_vocabulary} v WHERE v.word = w.lexeme)`,
      vocabularyEmpty: sql<boolean>`NOT EXISTS (SELECT 1 FROM ${search_vocabulary})`,
    })
    .from(sql`unnest(to_tsvector('simple', ${query})) AS w`)
  if (words.length === 0 || words[0]!.vocabularyEmpty) return null

  const unknown = words
    .filter(w => !w.known && !/\d/.test(w.word))
    .map(w => ({ word: w.word, maxEdits: maxEditsFor(w.word, config) }))
    .filter(w => w.maxEdits > 0)
  if (unknown.length === 0) return null

  const corrections = await db.transaction(async tx => {
    // The trigram lookup (%) uses this threshold.
    await tx.execute(sql.raw(`SET LOCAL pg_trgm.similarity_threshold = ${Number(config.typos.trigramThreshold)}`))
    const typed = sql.join(unknown.map(u => sql`(${u.word}::text, ${u.maxEdits}::int)`), sql`, `)
    return tx
      .select({ word: sql<string>`typed.word`, correction: sql<string>`best.word` })
      .from(sql`(VALUES ${typed}) AS typed (word, max_edits)
        CROSS JOIN LATERAL (
          SELECT v.word
          FROM ${search_vocabulary} v
          WHERE v.doc_count >= ${config.typos.minDocCount}
            AND (v.word % typed.word
                 OR (left(v.word, 1) = left(typed.word, 1)
                     AND length(v.word) BETWEEN length(typed.word) - typed.max_edits AND length(typed.word) + typed.max_edits))
            AND levenshtein_less_equal(v.word, typed.word, typed.max_edits) <= typed.max_edits
          ORDER BY levenshtein(v.word, typed.word), v.doc_count DESC, v.word
          LIMIT 1
        ) AS best`)
  }, { accessMode: 'read only' })
  if (corrections.length === 0) return null

  let corrected = query
  for (const { word, correction } of corrections) corrected = replaceWord(corrected, word, correction)
  return corrected === query ? null : corrected
}

/** Replaces whole-word, case-insensitive occurrences of `word` (Unicode letters and digits count as word characters). */
function replaceWord(text: string, word: string, replacement: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), replacement)
}
