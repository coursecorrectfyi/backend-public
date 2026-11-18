/**
 * The relevance judge: grades one (query, resource) pair at a time, 0–3.
 *
 * Pointwise on purpose: each pair is judged on its own, so the grade doesn't
 * depend on what else happened to be in the list or in which order. The judge
 * sees what a learner sees when deciding whether a result fits their search
 * (title, type, level, duration, skills, summary), but not the rating or the
 * number of ratings: relevance and quality are separate, and quality is
 * reported separately.
 *
 * Changing the prompt or the rubric means a new PROMPT_VERSION: judgments are
 * stored per model and prompt version, so old ones are then ignored (not
 * mixed in) and the pool is judged again.
 */
import { GoogleGenAI, Type } from '@google/genai'

export const PROMPT_VERSION = 'v1'

export interface JudgeResource {
  title: string
  provider: string
  provider_type: string | null
  resource_type: string
  institution: string | null
  level: string | null
  duration_hours: number | null
  skills: string[] | null
  ai_summary: string | null
}

export interface JudgeVerdict {
  grade: 0 | 1 | 2 | 3
  reason: string
}

export type JudgeFn = (query: string, resource: JudgeResource) => Promise<JudgeVerdict>

export interface JudgeConfig {
  /** The judge spec (see parseJudgeSpec), stored with every judgment. */
  model: string
  promptVersion: string
}

/**
 * A judge is named by a spec: a Gemini model, optionally with a thinking
 * budget, e.g. "gemini-2.5-flash" (the model's default thinking) or
 * "gemini-2.5-flash@thinking=0". The whole spec identifies the judge, so
 * judgments made with different settings are kept apart and can be compared.
 */
export function parseJudgeSpec(spec: string): { model: string; thinkingBudget?: number } {
  const match = /^([A-Za-z0-9._-]+)(?:@thinking=(\d+))?$/.exec(spec.trim())
  if (!match) throw new Error(`Invalid judge "${spec}": use a model name, optionally followed by @thinking=<tokens>`)
  return { model: match[1]!, ...(match[2] !== undefined ? { thinkingBudget: Number(match[2]) } : {}) }
}

export const RUBRIC = `3 = Highly relevant: its main subject is what the learner is looking for. If the search states a level (e.g. "for beginners"), a goal (a job, a certification) or a specific task, the result fits it.
2 = Relevant: covers what the learner is looking for substantially, but is broader, narrower or at another level than stated, or covers only part of what was asked.
1 = Marginal: mentions or touches on it, but a learner searching for this would not choose it.
0 = Not relevant.`

export function buildJudgePrompt(query: string, r: JudgeResource): string {
  const type = r.provider_type ? `${r.resource_type} (${r.provider_type})` : r.resource_type
  const offeredBy = r.institution ? `${r.institution}, on ${r.provider}` : r.provider
  const lines = [
    `- Title: ${r.title}`,
    `- Offered by: ${offeredBy}`,
    `- Type: ${type}`,
    r.level ? `- Level: ${r.level.replace('_', ' ')}` : null,
    r.duration_hours !== null ? `- Duration: about ${Math.round(r.duration_hours * 10) / 10} hours` : null,
    r.skills?.length ? `- Skills: ${r.skills.join(', ')}` : null,
    r.ai_summary ? `- Summary: ${r.ai_summary}` : null,
  ].filter(Boolean)

  return `You rate the results of a search engine for online courses, programs and degrees.

A learner searched for: ${JSON.stringify(query)}

One of the results:
${lines.join('\n')}

How well does this result match what the learner is looking for? Rate relevance only: ignore how good, popular or well rated the result might be.

${RUBRIC}

If the search is a job or career goal, a result is relevant to the extent that it prepares for that role. If the search names a certification, a result is highly relevant only if it prepares for that certification.

Answer with a one-sentence reason, then the grade.`
}

/** Validates the model's JSON answer. Throws on anything but a grade of 0–3 (number or digit string). */
export function parseJudgeReply(text: string): JudgeVerdict {
  const value = JSON.parse(text) as { grade?: unknown; reason?: unknown }
  const grade = typeof value.grade === 'string' && /^[0-3]$/.test(value.grade) ? Number(value.grade) : value.grade
  if (grade !== 0 && grade !== 1 && grade !== 2 && grade !== 3) throw new Error(`Judge: invalid grade in ${text.slice(0, 200)}`)
  return { grade, reason: typeof value.reason === 'string' ? value.reason.trim() : '' }
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ['reason', 'grade'],
  propertyOrdering: ['reason', 'grade'], // the reason first, so the grade follows from it
  properties: {
    reason: { type: Type.STRING },
    grade: { type: Type.STRING, enum: ['0', '1', '2', '3'] }, // Gemini's enums are strings
  },
}

/** A judge backed by Gemini on Vertex AI (Application Default Credentials, like the rest of the project). */
export function geminiJudge(options: { spec: string; project: string; location?: string }): JudgeFn {
  const { model, thinkingBudget } = parseJudgeSpec(options.spec)
  const ai = new GoogleGenAI({ vertexai: true, project: options.project, location: options.location ?? 'us-central1' })
  return async (query, resource) => {
    const result = await ai.models.generateContent({
      model,
      contents: buildJudgePrompt(query, resource),
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
      },
    })
    return parseJudgeReply(result.text ?? '')
  }
}
