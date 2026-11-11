/**
 * RAG retrieval helper for Cora (AI chat).
 *
 * retrieveForQuery embeds the user's message and returns the top-k semantically
 * similar resources from the full catalogue. Used by the chat endpoint to populate
 * the "additional catalogue context" block of the system prompt, alongside the
 * page context (resources the user is currently looking at).
 *
 * Key design decisions:
 * - Uses task_type=RETRIEVAL_QUERY (not RETRIEVAL_DOCUMENT) via embedQuery() —
 *   this aligns the query vector with the stored document vectors for better retrieval.
 * - excludeIds prevents returning resources already in page context, ensuring RAG
 *   always adds new information rather than repeating what the user can already see.
 * - Pure vector search (no text component) — page context already covers the
 *   keyword-matching case; RAG is specifically for semantic discovery beyond it.
 * - Throws on embedding failure — the caller (chat endpoint) should catch and
 *   fall back to page-context-only if needed.
 */

import { and, eq, notInArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { learning_resources } from '../db/schema.js'
import { embedQuery } from '../lib/embedding/vertex.js'

export interface RetrievedResource {
  id: string
  title: string
  provider: string
  resource_type: string
  institution: string | null
  level: string | null
  duration_hours: number | null
  rating: number | null
  num_ratings: number | null
  is_free: boolean | null
  has_certificate: boolean | null
  is_self_paced: boolean | null
  skills: string[] | null
  career_paths: string[] | null
  ai_summary: string | null
  ai_insights: {
    reviewInsights?: {
      sentiment: 'positive' | 'mixed' | 'negative'
      pros: string[]
      cons: string[]
    }
    careerInsights?: {
      job_roles: Array<{ title: string; salary_range: string; description: string }>
      growth_potential: string
    }
  } | null
}

/**
 * Embeds `query` and returns the top-`k` most semantically similar active resources.
 *
 * @param query     - The user's raw chat message. Embedded with RETRIEVAL_QUERY task type.
 * @param k         - Number of resources to return. Call site decides based on how much
 *                    page context is already present (fewer RAG results when page context
 *                    is large, to keep total prompt size manageable).
 * @param excludeIds - Resource IDs already in page context. Excluded from results so RAG
 *                    always adds new information rather than echoing what the user sees.
 * @throws          - If the Vertex AI embedding call fails. Caller should handle.
 */
export async function retrieveForQuery(
  query: string,
  k: number,
  excludeIds: string[] = [],
): Promise<RetrievedResource[]> {
  const queryVector = await embedQuery(query)
  const vectorLiteral = `[${queryVector.join(',')}]`

  const conditions = [
    eq(learning_resources.is_active, true),
    sql`${learning_resources.embedding} IS NOT NULL`,
    ...(excludeIds.length > 0 ? [notInArray(learning_resources.id, excludeIds)] : []),
  ]

  const rows = await db
    .select({
      id:              learning_resources.id,
      title:           learning_resources.title,
      provider:        learning_resources.provider,
      resource_type:   learning_resources.resource_type,
      institution:     learning_resources.institution,
      level:           learning_resources.level,
      duration_hours:  learning_resources.duration_hours,
      rating:          learning_resources.rating,
      num_ratings:     learning_resources.num_ratings,
      is_free:         learning_resources.is_free,
      has_certificate: learning_resources.has_certificate,
      is_self_paced:   learning_resources.is_self_paced,
      skills:          learning_resources.skills,
      career_paths:    learning_resources.career_paths,
      ai_summary:      learning_resources.ai_summary,
      ai_insights:     learning_resources.ai_insights,
    })
    .from(learning_resources)
    .where(and(...conditions))
    // <=> is pgvector cosine distance (0 = identical, 2 = opposite).
    // ORDER BY ASC gives most similar first.
    .orderBy(sql`${learning_resources.embedding} <=> ${vectorLiteral}::vector`)
    .limit(k)

  return rows
}
