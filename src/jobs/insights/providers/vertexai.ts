/**
 * Vertex AI provider for AI insights generation.
 * Uses Application Default Credentials (service account in Cloud Run — no API key needed).
 * Paid tier: no meaningful rate limits for a one-time batch.
 *
 * Required env vars:
 *   GOOGLE_CLOUD_PROJECT  — GCP project ID (already set on all Cloud Run jobs)
 */

import { GoogleGenAI, Type } from '@google/genai'
import type { AiInsights } from './types.js'

const MODEL = 'gemini-2.5-flash'
const MAX_RETRIES = 3

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

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: 'us-central1',
})

export async function callVertexAi(prompt: string): Promise<AiInsights> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await ai.models.generateContent({
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

      if (attempt < MAX_RETRIES) {
        const is429 = lastError.message.includes('429') || lastError.message.includes('RESOURCE_EXHAUSTED')
        const baseMs = is429 ? 5_000 : 2_000
        await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt)))
      }
    }
  }

  throw new Error(`Vertex AI insights failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`)
}
