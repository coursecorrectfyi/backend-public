/**
 * Gemini provider for AI insights generation.
 * Uses Google AI Studio free tier via @google/genai SDK.
 * Free tier limit: 20 RPD for gemini-2.5-flash-lite.
 *
 * Required env var: GEMINI_API_KEY (from AI Studio)
 */

import { GoogleGenAI, Type } from '@google/genai'
import { DailyQuotaExhaustedError } from '../errors.js'
import type { AiInsights } from './types.js'

const MODEL = 'gemini-2.5-flash-lite'
const MAX_RETRIES = 2

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ['reviewInsights', 'careerInsights'],
  properties: {
    reviewInsights: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        sentiment: { type: Type.STRING, enum: ['positive', 'mixed', 'negative'] },
        pros: { type: Type.ARRAY, items: { type: Type.STRING } },
        cons: { type: Type.ARRAY, items: { type: Type.STRING } },
        representative_quotes: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['sentiment', 'pros', 'cons', 'representative_quotes'],
    },
    careerInsights: {
      type: Type.OBJECT,
      properties: {
        job_roles: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            required: ['title', 'salary_range', 'description'],
            properties: {
              title:        { type: Type.STRING },
              salary_range: { type: Type.STRING },
              description:  { type: Type.STRING },
            },
          },
        },
        complementary_skills: { type: Type.ARRAY, items: { type: Type.STRING } },
        growth_potential: { type: Type.STRING },
      },
      required: ['job_roles', 'complementary_skills', 'growth_potential'],
    },
  },
}

let _ai: GoogleGenAI | null = null
function getClient(): GoogleGenAI {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })
  return _ai
}

export async function callGemini(prompt: string): Promise<AiInsights> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await getClient().models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      })
      const text = result.text ?? ''
      return JSON.parse(text) as AiInsights
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Daily quota exhausted — specific quotaId only present in daily limit errors.
      if (lastError.message.includes('GenerateRequestsPerDayPerProjectPerModel')) {
        throw new DailyQuotaExhaustedError(lastError.message)
      }

      if (attempt < MAX_RETRIES) {
        const is429 = lastError.message.includes('429') || lastError.message.includes('RESOURCE_EXHAUSTED')
        const baseMs = is429 ? 30_000 : 2_000
        await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt)))
      }
    }
  }

  throw new Error(`Gemini insights failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`)
}
