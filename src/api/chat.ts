/**
 * POST /api/v1/chat — Cora AI chat endpoint (SSE streaming).
 *
 * Auth: optional. Signed-in users send `Authorization: Bearer <token>` and get
 * a higher daily limit (10), plus a shared total for all signed-in questions.
 * Anonymous users send `X-Session-ID: <uuid>` and get a lower limit (5), plus
 * shared per-IP and total caps on anonymous questions. Limits are counted in
 * `chat_usage` (see chat-usage.ts).
 *
 * Request body: see docs/api.md. Size limits are in chat-input.ts.
 *
 * Response: Server-Sent Events stream.
 *   data: {"type":"delta","content":"..."}  — one or more text chunks
 *   data: {"type":"done"}                   — stream complete
 *   data: {"type":"error","message":"..."}  — generation failed
 *   HTTP 503 JSON                           — chat switched off by CHAT_MODE (no stream)
 *   HTTP 400 JSON                           — invalid body or identity headers
 *   HTTP 413 JSON                           — body over 512 KB (src/index.ts)
 *   HTTP 429 JSON + Retry-After             — a daily limit (limit-responses.ts), or the
 *                                             per-minute rate limit (src/index.ts)
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { verify } from 'hono/jwt'
import { GoogleGenAI } from '@google/genai'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { learning_resources } from '../db/schema.js'
import { retrieveForQuery } from './rag.js'
import { matchResourceIds } from './resource-ids.js'
import { buildRagQuery, parseChatBody, type CurrentPage } from './chat-input.js'
import {
  LIMIT_ANONYMOUS, LIMIT_SIGNED_IN, checkAndIncrementUsage, readChatLimits, refundUsage,
  secondsUntilUtcMidnight, usageCounters, type LimitScope,
} from './chat-usage.js'
import { dailyLimitResponse } from './limit-responses.js'
import { isUuid } from '../lib/ids.js'
import { trustProxyHops } from '../lib/client-ip.js'
import { readEnumEnv } from '../lib/env.js'
import { log, logError } from '../lib/logger.js'
import {
  ClientDisconnected, GenerationTimeout, GENERATION_TIMEOUT_MS, MAX_OUTPUT_TOKENS, MODEL, TEMPERATURE,
  THINKING_BUDGET, TRUNCATION_NOTICE, abortable, untilAborted,
} from './chat-generation.js'

export const chatRouter = new Hono()

// ─── Config ───────────────────────────────────────────────────────────────────

const RAG_K = 6

// Read once at startup: an invalid value throws, so a bad deploy config stops
// the new revision from starting instead of running with unintended limits.
const CHAT_LIMITS_PER_DAY = readChatLimits()
const TRUST_PROXY_HOPS = trustProxyHops()

/**
 * Emergency switch (docs/deployment-gcp.md §6), changed without a build:
 *   on              normal
 *   signed_in_only  anonymous questions are refused (e.g. guests are abusing it)
 *   off             every question is refused (e.g. Gemini spend is running away)
 * Refused questions get 503 before any paid work (embedding, Gemini) or any
 * counting. The daily limits can't do this: 0 means "no limit" there.
 */
export const CHAT_MODES = ['on', 'signed_in_only', 'off'] as const
const CHAT_MODE = readEnumEnv('CHAT_MODE', CHAT_MODES, 'on')
if (CHAT_MODE !== 'on') {
  // Once per instance start, so the logs show the switch took effect.
  log({ event: 'chat_mode', mode: CHAT_MODE }, 'warn')
}

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT ?? 'your-gcp-project-id',
  location: 'us-central1',
})

// ─── Identity resolution ──────────────────────────────────────────────────────
//
// Signed-in: verifies the backend JWT and uses the Firebase UID.
// Anonymous: uses the X-Session-ID header, a UUID the browser generates and
// keeps in localStorage. It must be a UUID (stored lowercase): free-form ids
// could be made up endlessly, grow chat_usage without bound, or collide with a
// Firebase UID and use up that user's questions.

type Identity = { kind: 'user' | 'anon'; identity: string }

async function resolveIdentity(
  authHeader: string | undefined,
  sessionId: string | undefined,
  secret: string,
): Promise<Identity | { error: string }> {
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const payload = await verify(token, secret, 'HS256') as Record<string, unknown>
      if (payload['type'] === 'access' && typeof payload['sub'] === 'string') {
        return { kind: 'user', identity: payload['sub'] }
      }
    } catch {
      // Invalid token — fall through to anonymous
    }
  }

  const session = sessionId?.trim()
  if (!session) {
    return { error: 'Provide Authorization: Bearer <token> or X-Session-ID header' }
  }
  if (!isUuid(session)) {
    return { error: 'X-Session-ID must be a UUID' }
  }
  return { kind: 'anon', identity: session.toLowerCase() }
}

/** The 429 message for each limit. The frontend shows it as is. */
function limitMessage(scope: LimitScope): string {
  switch (scope) {
    case 'user':
      return `You've used all ${LIMIT_SIGNED_IN} of your daily questions. Your limit resets at midnight UTC.`
    case 'session':
      return `You've used all ${LIMIT_ANONYMOUS} of your daily questions. Sign in to get ${LIMIT_SIGNED_IN} questions per day.`
    case 'ip':
      return `Too many questions from your network today. Sign in to get ${LIMIT_SIGNED_IN} questions per day.`
    case 'global':
      return `Cora has reached today's limit for guest questions. Sign in to get ${LIMIT_SIGNED_IN} questions per day.`
    case 'signed_in_global':
      return "Cora has reached today's limit for questions. Please try again after midnight UTC."
  }
}

// ─── System prompt assembly ───────────────────────────────────────────────────

function pageDescription(currentPage: CurrentPage, searchTerm?: string): string {
  switch (currentPage) {
    case 'SearchResult':
      return searchTerm
        ? `The user is viewing search results for "${searchTerm}".`
        : 'The user is viewing search results.'
    case 'SavedCourses':
      return 'The user is viewing their saved/shortlisted resources.'
    case 'CourseDetail':
      return 'The user is viewing the detail page for a specific resource.'
    case 'SubjectPage':
      return searchTerm
        ? `The user is browsing the "${searchTerm}" subject page.`
        : 'The user is browsing a subject page.'
  }
}

function titleToSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function formatResource(r: {
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
    reviewInsights?: { sentiment: string; pros: string[]; cons: string[] }
    careerInsights?: {
      job_roles: Array<{ title: string; salary_range: string; description: string }>
      growth_potential: string
    }
  } | null
}): string {
  // Always link to CourseCorrect resource page, not the provider/affiliate URL directly.
  // This keeps users on our platform and lets us track engagement.
  const ccUrl = `https://coursecorrect.fyi/learn/${titleToSlug(r.title)}/${r.id}`

  const meta: string[] = [r.provider, r.resource_type]
  if (r.institution) meta.push(r.institution)
  if (r.level) meta.push(r.level)

  const attrs: string[] = []
  if (r.rating != null) {
    attrs.push(`${r.rating.toFixed(1)}★${r.num_ratings != null ? ` (${r.num_ratings.toLocaleString()} ratings)` : ''}`)
  }
  if (r.duration_hours != null) attrs.push(`~${r.duration_hours}h`)
  if (r.is_free != null) attrs.push(r.is_free ? 'Free' : 'Paid')
  if (r.has_certificate != null) attrs.push(r.has_certificate ? 'Certificate included' : 'No certificate')
  if (r.is_self_paced != null) attrs.push(r.is_self_paced ? 'Self-paced' : 'Fixed schedule')

  const parts: (string | null)[] = [
    `[${r.title}](${ccUrl}) (${meta.join(', ')})`,
    attrs.length ? attrs.join(' | ') : null,
    r.skills?.length ? `Skills: ${r.skills.slice(0, 6).join(', ')}` : null,
    r.career_paths?.length ? `Career paths: ${r.career_paths.join(', ')}` : null,
    r.ai_summary ?? null,
  ]

  if (r.ai_insights?.reviewInsights) {
    const ri = r.ai_insights.reviewInsights
    parts.push(`Review sentiment: ${ri.sentiment}`)
    if (ri.pros.length) parts.push(`Pros: ${ri.pros.join('; ')}`)
    if (ri.cons.length) parts.push(`Cons: ${ri.cons.join('; ')}`)
  }

  if (r.ai_insights?.careerInsights) {
    const ci = r.ai_insights.careerInsights
    if (ci.job_roles.length) {
      parts.push(`Job roles: ${ci.job_roles.map(j => `${j.title} (${j.salary_range})`).join(', ')}`)
    }
    if (ci.growth_potential) parts.push(`Growth potential: ${ci.growth_potential}`)
  }

  return parts.filter(Boolean).join('\n')
}

function buildSystemPrompt(
  currentPage: CurrentPage,
  searchTerm: string | undefined,
  pageContextResources: Array<Parameters<typeof formatResource>[0]>,
  ragResources: Array<Parameters<typeof formatResource>[0]>,
): string {
  const sections: string[] = [
    `You are Cora, an expert learning advisor for CourseCorrect — a platform that helps people find the right courses, programs, degrees, and certifications.
Your role is to help users make informed decisions about their learning journey. Be concise, specific, and honest. Avoid marketing language.
${pageDescription(currentPage, searchTerm)}`,
  ]

  if (pageContextResources.length > 0) {
    sections.push(
      `## Resources the user is currently looking at\n\n${pageContextResources.map(formatResource).join('\n\n---\n\n')}`,
    )
  }

  if (ragResources.length > 0) {
    sections.push(
      `## Additional relevant resources from the CourseCorrect catalogue\nThese are not visible to the user but may be more relevant to their specific question. Mention them when they are a meaningfully better fit.\n\n${ragResources.map(formatResource).join('\n\n---\n\n')}`,
    )
  }

  sections.push(
    `## Guidelines
- Ground your responses in the resources provided above. Always cite the resource name when you reference it.
- If something from the additional catalogue resources is a better fit for the user's stated need, proactively mention it by name.
- When recommending a resource, always write the resource as a markdown inline link: [Resource Name](https://coursecorrect.fyi/...). Copy the exact link from the resource data above — it is already in this format. Never write just [Resource Name] without the URL in parentheses.
- If you don't have enough information to give a confident answer, say so and ask a clarifying question.
- If a user asks for a link to a resource you mentioned in a previous turn but it is no longer in your current context, say you don't have it available right now and suggest they search for it by name on CourseCorrect. Never claim a resource does not exist.
- Keep responses focused and actionable. Bullet points are fine for comparisons.`,
  )

  return sections.join('\n\n')
}

// ─── Chat endpoint ────────────────────────────────────────────────────────────

chatRouter.post('/', async (c) => {
  if (CHAT_MODE === 'off') {
    return c.json({
      error: 'Chat is unavailable',
      code: 'chat_unavailable',
      message: 'Cora is taking a break. Please try again later.',
    }, 503)
  }

  const secret = process.env.JWT_SECRET
  if (!secret) {
    return c.json({ error: 'Server configuration error' }, 500)
  }

  // ── 1. Parse request ─────────────────────────────────────────────────────

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // Validates `message` and bounds every other field (see chat-input.ts).
  // Page context ids may be UUIDs or legacy MongoDB ids (see matchResourceIds).
  // History is prior conversation turns, oldest first.
  const parsed = parseChatBody(body)
  if (!parsed.ok) {
    return c.json(parsed.error, 400)
  }
  const { message, pageContextIds, currentPage, searchTerm, history } = parsed.input

  // ── 2. Resolve identity and enforce usage limits (see chat-usage.ts) ─────

  const resolved = await resolveIdentity(c.req.header('Authorization'), c.req.header('X-Session-ID'), secret)
  if ('error' in resolved) {
    return c.json({ error: resolved.error }, 400)
  }
  if (CHAT_MODE === 'signed_in_only' && resolved.kind === 'anon') {
    return c.json({
      error: 'Chat is unavailable for guests',
      code: 'chat_signed_in_only',
      message: 'Cora is only available to signed-in users right now. Sign in to continue.',
    }, 503)
  }

  // Only anonymous questions are counted per IP. c.var.client is the visitor a
  // trusted relay names, or the connection's client (middleware/client.ts).
  const client = resolved.kind === 'anon' ? c.get('client').key : null
  if (resolved.kind === 'anon' && client === null && CHAT_LIMITS_PER_DAY.ipDailyLimit > 0) {
    // Not expected on Cloud Run (its front end always sends X-Forwarded-For):
    // the per-IP limit is skipped, the session and global limits still apply.
    log({ event: 'client_ip_unknown', route: 'chat', trust_proxy_hops: TRUST_PROXY_HOPS }, 'warn')
  }

  const usage = await checkAndIncrementUsage(usageCounters(resolved, client, CHAT_LIMITS_PER_DAY, secret))

  if (!usage.allowed) {
    if (usage.scope !== 'user' && usage.scope !== 'session') {
      // Shared limits: signals abuse, a shared-IP misconfiguration
      // (docs/deployment-gcp.md §6) or, for the totals, that chat is off for
      // a whole group until midnight UTC (docs/monitoring.md §5).
      log({ event: 'chat_limit_reached', scope: usage.scope }, 'warn')
    }
    return dailyLimitResponse(c, usage.scope, limitMessage(usage.scope), secondsUntilUtcMidnight())
  }

  // ── 3. Fetch page context resources from DB ──────────────────────────────

  let pageContextResources: Array<{
    id: string; title: string; provider: string; resource_type: string
    institution: string | null; level: string | null; duration_hours: number | null
    rating: number | null; num_ratings: number | null; is_free: boolean | null
    has_certificate: boolean | null; is_self_paced: boolean | null
    skills: string[] | null; career_paths: string[] | null; ai_summary: string | null
    ai_insights: {
      reviewInsights?: { sentiment: string; pros: string[]; cons: string[] }
      careerInsights?: {
        job_roles: Array<{ title: string; salary_range: string; description: string }>
        growth_potential: string
      }
    } | null
  }> = []

  const pageContextMatch = matchResourceIds(pageContextIds)
  if (pageContextMatch) {
    pageContextResources = await db
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
      .where(and(eq(learning_resources.is_active, true), pageContextMatch))
  }

  // ── 4. RAG retrieval — top-k from catalogue, excluding page context ──────
  //
  // Short follow-ups are augmented with the last bot turn (see buildRagQuery).

  const ragQuery = buildRagQuery(message, history)

  let ragResources: Awaited<ReturnType<typeof retrieveForQuery>> = []
  try {
    // Exclude by resolved UUID: page context may have used legacy ids
    ragResources = await retrieveForQuery(ragQuery, RAG_K, pageContextResources.map(r => r.id))
  } catch (err) {
    // Non-fatal: fall back to page-context-only if embedding fails
    logError('chat_rag_failed', err)
  }

  // ── 5. Assemble prompt and stream Gemini response ────────────────────────

  const systemPrompt = buildSystemPrompt(currentPage, searchTerm, pageContextResources, ragResources)

  const { queryDate, identities } = usage

  return streamSSE(c, async (stream) => {
    // Stop waiting for Gemini when the client goes away or the answer takes
    // too long (see chat-generation.ts). Both end the request at once.
    const clientGone = new AbortController()
    stream.onAbort(() => clientGone.abort(new ClientDisconnected()))
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new GenerationTimeout()), GENERATION_TIMEOUT_MS)
    const signal = AbortSignal.any([clientGone.signal, timeout.signal])

    // Whether Gemini produced any answer text. If it fails (or times out)
    // before that, the question is given back (refundUsage) so outages don't
    // use up the daily limit. Set before the text is written, so a client that
    // doesn't read the stream can't turn a delivered answer into a refund.
    let gotText = false
    let finishReason: string | undefined
    let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined
    let outcome: 'completed' | 'truncated' | 'client_disconnected' | 'timeout' | 'error' = 'completed'
    const startedAt = Date.now()

    try {
      // Build multi-turn contents: prior history + current user message.
      // Gemini uses 'user' and 'model' roles — 'bot' maps to 'model'.
      const contents = [
        ...history.map(t => ({
          role: t.role === 'bot' ? 'model' : 'user',
          parts: [{ text: t.content }],
        })),
        { role: 'user', parts: [{ text: message }] },
      ]

      const response = await untilAborted(ai.models.generateContentStream({
        model: MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingBudget: THINKING_BUDGET },
          abortSignal: signal,
        },
      }), signal)

      for await (const chunk of abortable(response, signal)) {
        finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason
        usageMetadata = chunk.usageMetadata ?? usageMetadata
        const text = chunk.text
        if (text) {
          gotText = true
          await stream.writeSSE({
            data: JSON.stringify({ type: 'delta', content: text }),
          })
        }
      }

      // The answer reached ANSWER_MAX_TOKENS: say so instead of ending mid-sentence.
      const truncated = finishReason === 'MAX_TOKENS'
      if (truncated) {
        outcome = 'truncated'
        await stream.writeSSE({ data: JSON.stringify({ type: 'delta', content: TRUNCATION_NOTICE }) })
      }
      await stream.writeSSE({ data: JSON.stringify(truncated ? { type: 'done', truncated: true } : { type: 'done' }) })
    } catch (err) {
      if (clientGone.signal.aborted) {
        // Nobody is listening. The question still counts: Gemini was already
        // called (and bills for it), and refunding would let a client get
        // unlimited questions by disconnecting before the first word.
        outcome = 'client_disconnected'
        return
      }
      outcome = timeout.signal.aborted ? 'timeout' : 'error'
      logError('chat_generation_failed', err, { outcome })
      if (!gotText) {
        await refundUsage(identities, queryDate).catch((refundErr: unknown) => {
          logError('chat_refund_failed', refundErr)
        })
      }
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: 'Something went wrong. Please try again.' }),
      })
    } finally {
      clearTimeout(timer)
      // One line per question for cost monitoring (docs/operations.md). No
      // message content and no identity, only the kind of user.
      log({
        event: 'chat_answer',
        outcome,
        identity_type: resolved.kind,
        duration_ms: Date.now() - startedAt,
        prompt_tokens: usageMetadata?.promptTokenCount ?? null,
        thinking_tokens: usageMetadata?.thoughtsTokenCount ?? null,
        answer_tokens: usageMetadata?.candidatesTokenCount ?? null,
      })
    }
  })
})
