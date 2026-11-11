/**
 * Groq provider for AI insights generation.
 * Uses Llama 3.3 70B Versatile via Groq's free inference API.
 * Free tier limit: ~14,400 RPD (no credit card required).
 *
 * Required env var: GROQ_API_KEY (from console.groq.com)
 */

import Groq from 'groq-sdk'
import { DailyQuotaExhaustedError } from '../errors.js'
import type { AiInsights } from './types.js'

const MODEL = 'llama-3.1-8b-instant'
const MAX_RETRIES = 2

// Groq doesn't support responseSchema — we instruct the model via system prompt
// and parse the JSON output. `response_format: { type: 'json_object' }` ensures
// valid JSON is always returned.
const SYSTEM_PROMPT = `You are a structured data extraction assistant. Always respond with valid JSON matching this exact schema:

{
  "reviewInsights": {
    "sentiment": "positive" | "mixed" | "negative",
    "pros": [string, ...],        // 3-5 items
    "cons": [string, ...],        // 2-4 items
    "representative_quotes": [string, ...]  // 2-3 items
  } | null,                       // null if no reviews provided
  "careerInsights": {
    "job_roles": [
      {
        "title": string,
        "salary_range": string,    // format: "$73K–$125K/yr"
        "description": string
      },
      ...                          // 3-5 items
    ],
    "complementary_skills": [string, ...],  // 3-5 items
    "growth_potential": string     // 1-2 sentences
  }
}

No additional keys. No markdown. Pure JSON only.`

let _groq: Groq | null = null
function getClient(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })
  return _groq
}

export async function callGroq(prompt: string): Promise<AiInsights> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await getClient().chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 8192,
      })
      const text = completion.choices[0]?.message?.content ?? ''
      return JSON.parse(text) as AiInsights
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Groq daily quota: TPD (tokens per day) is the real ceiling.
      // Error message contains "per day" for both RPD and TPD exhaustion.
      if (lastError.message.includes('per day')) {
        throw new DailyQuotaExhaustedError(lastError.message)
      }

      if (attempt < MAX_RETRIES) {
        const is429 = lastError.message.includes('429') || lastError.message.toLowerCase().includes('rate_limit')
        const baseMs = is429 ? 10_000 : 2_000
        await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt)))
      }
    }
  }

  throw new Error(`Groq insights failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`)
}
