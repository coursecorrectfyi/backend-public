/**
 * The keyword terms of a query: its lexemes (English stemming, stop words
 * removed, as in search_document), in the order they appear in the query.
 */
import { sql } from 'drizzle-orm'
import type { SearchConfig } from './config.js'
import type { Db } from './db.js'

/**
 * Lexemes for keyword matching. Generic catalogue words (config) are left
 * out, unless the query has nothing else (e.g. "best courses"). At most
 * `maxTerms`, the first ones in the query. Empty for a query of stop words
 * only (e.g. "how to"): then only the semantic side can match.
 */
export async function keywordTerms(db: Db, text: string, config: SearchConfig): Promise<string[]> {
  const generic = config.keyword.genericWords.join(' ')
  const lexemes = await db
    .select({
      lexeme: sql<string>`t.lexeme`,
      generic: sql<boolean>`t.lexeme = ANY (tsvector_to_array(to_tsvector('english', ${generic})))`,
    })
    .from(sql`unnest(to_tsvector('english', ${text})) AS t`)
    .orderBy(sql`t.positions[1]`)
  const specific = lexemes.filter(l => !l.generic)
  return (specific.length > 0 ? specific : lexemes).map(l => l.lexeme).slice(0, config.keyword.maxTerms)
}

/** A tsquery literal that matches the lexemes exactly as given (already stemmed: no parsing, no stemming). */
export function tsqueryOf(lexemes: readonly string[], operator: '&' | '|'): string {
  return lexemes.map(l => `'${l.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(` ${operator} `)
}
