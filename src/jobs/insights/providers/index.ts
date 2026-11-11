/**
 * LLM provider switcher for insights generation.
 *
 * Switch providers by setting INSIGHTS_PROVIDER env var:
 *   INSIGHTS_PROVIDER=gemini   — Google AI Studio (20 RPD free)
 *   INSIGHTS_PROVIDER=groq     — Groq Llama 3.3 70B (~14,400 RPD free, default)
 *
 * Required env vars per provider:
 *   gemini: GEMINI_API_KEY
 *   groq:   GROQ_API_KEY
 */

import { callGemini } from './gemini.js'
import { callGroq } from './groq.js'
import { callVertexAi } from './vertexai.js'
import type { AiInsights } from './types.js'

// ── Change this line to switch providers ──────────────────────────────────────
const INSIGHTS_PROVIDER = (process.env.INSIGHTS_PROVIDER ?? 'vertexai') as 'gemini' | 'groq' | 'vertexai'
// ─────────────────────────────────────────────────────────────────────────────

export async function callLlm(prompt: string): Promise<AiInsights> {
  switch (INSIGHTS_PROVIDER) {
    case 'vertexai': return callVertexAi(prompt)
    case 'gemini':   return callGemini(prompt)
    case 'groq':     return callGroq(prompt)
    default:
      throw new Error(`Unknown INSIGHTS_PROVIDER: "${INSIGHTS_PROVIDER}". Valid values: vertexai, gemini, groq`)
  }
}

export { type AiInsights } from './types.js'
