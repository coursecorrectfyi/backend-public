/**
 * Vertex AI text-embedding-004 client.
 *
 * The @google-cloud/vertexai SDK only exposes generative models — embeddings
 * must be called via the Vertex AI prediction REST API directly.
 * Authentication uses google-auth-library (already a transitive dependency),
 * which resolves credentials from ADC locally and the service account on Cloud Run.
 *
 * Model: text-embedding-004 (us-central1)
 * Dimensions: 768
 * Max tokens per input: 2048 (longer inputs are truncated)
 * Max instances per request: 250 (we use 100 for headroom)
 *
 * task_type usage:
 *   RETRIEVAL_DOCUMENT — used here (documents being indexed into pgvector)
 *   RETRIEVAL_QUERY    — used at search time when embedding the user's query
 * Using the correct task_type improves retrieval quality.
 *
 * Estimated cost: ~$0.000025 per 1k characters ≈ $1 for 22k courses
 */

import { GoogleAuth } from 'google-auth-library'

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? 'your-gcp-project-id'
const LOCATION = 'us-central1'
const MODEL = 'text-embedding-004'
const API_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`

/** Maximum instances per API call (API allows up to 250; 100 gives safe headroom). */
export const EMBEDDING_BATCH_SIZE = 100

/** Embedding vector dimensions — must match the HNSW index on learning_resources.embedding. */
export const EMBEDDING_DIMENSIONS = 768

const MAX_RETRIES = 2

// Singleton auth client — caches tokens and refreshes them automatically.
const auth = new GoogleAuth({
  scopes: 'https://www.googleapis.com/auth/cloud-platform',
})

/**
 * Constructs the embedding input string for a learning resource.
 *
 * Format: "{title} | {provider_type} | {institution} | {level} | {skills} | {ai_summary}"
 * Null/empty fields are omitted so they don't waste token budget.
 * Skills array is joined with commas.
 *
 * This format is also used at query time (with task_type=RETRIEVAL_QUERY) to ensure
 * the query embedding lives in the same semantic space as the document embeddings.
 */
export function buildEmbeddingInput(row: {
  title: string
  provider_type: string | null
  institution: string | null
  level: string | null
  skills: string[] | null
  ai_summary: string | null
}): string {
  return [
    row.title,
    row.provider_type,
    row.institution,
    row.level,
    row.skills?.length ? row.skills.join(', ') : null,
    row.ai_summary,
  ]
    .filter(Boolean)
    .join(' | ')
}

interface EmbeddingResult {
  values: number[]
  tokenCount: number
  truncated: boolean
}

/**
 * Calls text-embedding-004 for a batch of texts.
 *
 * @param texts - Up to EMBEDDING_BATCH_SIZE strings to embed in one API call.
 * @returns Array of embedding results in the same order as the input texts.
 * @throws If the API fails after all retries.
 */
export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return []
  if (texts.length > EMBEDDING_BATCH_SIZE) {
    throw new Error(`embedBatch: too many inputs (${texts.length} > ${EMBEDDING_BATCH_SIZE})`)
  }

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = await auth.getClient()
      const { token } = await client.getAccessToken()

      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          instances: texts.map(content => ({
            content,
            task_type: 'RETRIEVAL_DOCUMENT',
          })),
        }),
      })

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(`Vertex AI embedding API ${response.status}: ${errorBody.slice(0, 300)}`)
      }

      const data = (await response.json()) as {
        predictions: Array<{
          embeddings: {
            values: number[]
            statistics: { token_count: number; truncated: boolean }
          }
        }>
      }

      return data.predictions.map(p => ({
        values: p.embeddings.values,
        tokenCount: p.embeddings.statistics.token_count,
        truncated: p.embeddings.statistics.truncated,
      }))
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
  }

  throw new Error(
    `Vertex AI embedding failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
  )
}

/**
 * Embeds a single search query using task_type=RETRIEVAL_QUERY.
 * Must use a different task_type from document embeddings (RETRIEVAL_DOCUMENT)
 * so the query lives in the correct semantic space for retrieval.
 *
 * @throws If the API fails — callers should catch and fall back to keyword-only search.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const client = await auth.getClient()
  const { token } = await client.getAccessToken()

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      instances: [{ content: text, task_type: 'RETRIEVAL_QUERY' }],
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Vertex AI embedding API ${response.status}: ${errorBody.slice(0, 300)}`)
  }

  const data = (await response.json()) as {
    predictions: Array<{ embeddings: { values: number[] } }>
  }
  return data.predictions[0].embeddings.values
}
