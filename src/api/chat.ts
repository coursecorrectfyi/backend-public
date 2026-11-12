/**
 * POST /api/v1/chat — Cora AI chat endpoint (SSE streaming).
 *
 * Auth: optional. Signed-in users send `Authorization: Bearer <token>` and get
 * a higher daily limit (10). Anonymous users send `X-Session-ID: <uuid>` and
 * get a lower limit (5). Both identities are tracked in `chat_usage`.
 *
 * Response: Server-Sent Events stream.
 *   data: {"type":"delta","content":"..."}  — one or more text chunks
 *   data: {"type":"done"}                   — stream complete
 *   HTTP 429 JSON                           — daily limit exceeded (no stream)
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { verify } from 'hono/jwt'
import { GoogleGenAI } from '@google/genai'
import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { learning_resources, chat_usage } from '../db/schema.js'
import { retrieveForQuery } from './rag.js'
import { matchResourceIds } from './resource-ids.js'

export const chatRouter = new Hono()

// ─── Config ───────────────────────────────────────────────────────────────────

const LIMIT_SIGNED_IN = 10
const LIMIT_ANONYMOUS = 5
const RAG_K = 6
const MODEL = 'gemini-2.5-flash'

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT ?? 'your-gcp-project-id',
  location: 'us-central1',
})

// ─── Usage limit enforcement (M8.3) ──────────────────────────────────────────
//
// Hold, then release: a question is counted when it arrives and given back
// (refundUsage) if Gemini fails before sending any text. Requests over the
// limit are rejected and leave no trace in the DB.
//
// Checking the limit and counting the question is ONE atomic statement: the
// upsert only increments while count < limit, and Postgres locks the row while
// it does so. Simultaneous requests therefore queue up and can't slip past the
// limit (a separate SELECT-then-INSERT let 9 of 10 simultaneous requests
// through an anonymous limit of 5).

async function checkAndIncrementUsage(
  identity: string,
  identityType: 'user' | 'anon',
  limit: number,
): Promise<{ allowed: false; remaining: 0 } | { allowed: true; remaining: number; queryDate: string }> {
  const [counted] = await db
    .insert(chat_usage)
    .values({
      identity,
      identity_type: identityType,
      query_date: sql`CURRENT_DATE`,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [chat_usage.identity, chat_usage.query_date],
      set: { count: sql`${chat_usage.count} + 1` },
      // Only count the question while under the limit. When this is false,
      // nothing is updated and no row comes back.
      setWhere: sql`${chat_usage.count} < ${limit}`,
    })
    .returning({ count: chat_usage.count, queryDate: chat_usage.query_date })

  if (!counted) {
    return { allowed: false, remaining: 0 }
  }

  return { allowed: true, remaining: limit - counted.count, queryDate: counted.queryDate }
}

/**
 * Gives back a question that was counted but never answered (Gemini failed
 * before sending any text). Uses the date the question was counted against,
 * so a failure just after midnight doesn't take one off the new day.
 */
async function refundUsage(identity: string, queryDate: string): Promise<void> {
  await db
    .update(chat_usage)
    .set({ count: sql`${chat_usage.count} - 1` })
    .where(
      and(
        eq(chat_usage.identity, identity),
        eq(chat_usage.query_date, queryDate),
        gt(chat_usage.count, 0),
      ),
    )
}

// ─── Identity resolution ──────────────────────────────────────────────────────
//
// Returns { identity, identityType, limit } from the request context.
// Signed-in: verifies the backend JWT and extracts the Firebase UID.
// Anonymous: uses the X-Session-ID header (client-generated UUID in localStorage).

async function resolveIdentity(
  authHeader: string | undefined,
  sessionId: string | undefined,
  secret: string,
): Promise<{ identity: string; identityType: 'user' | 'anon'; limit: number } | null> {
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const payload = await verify(token, secret, 'HS256') as Record<string, unknown>
      if (payload['type'] === 'access' && typeof payload['sub'] === 'string') {
        return { identity: payload['sub'], identityType: 'user', limit: LIMIT_SIGNED_IN }
      }
    } catch {
      // Invalid token — fall through to anonymous
    }
  }

  if (sessionId?.trim()) {
    return { identity: sessionId.trim(), identityType: 'anon', limit: LIMIT_ANONYMOUS }
  }

  return null
}

// ─── System prompt assembly ───────────────────────────────────────────────────

type CurrentPage = 'SearchResult' | 'SavedCourses' | 'CourseDetail' | 'SubjectPage'

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
  const secret = process.env.JWT_SECRET
  if (!secret) {
    return c.json({ error: 'Server configuration error' }, 500)
  }

  // ── 1. Parse request ─────────────────────────────────────────────────────

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const message = typeof body['message'] === 'string' ? body['message'].trim() : ''
  if (!message) {
    return c.json({ error: 'message is required' }, 400)
  }

  // Accept both `pageContextIds` (new) and `courseIds` (legacy frontend) during transition.
  // Each id may be a UUID or a legacy MongoDB ID (see matchResourceIds).
  const rawIds = body['pageContextIds'] ?? body['courseIds']
  const pageContextIds: string[] = Array.isArray(rawIds)
    ? rawIds.filter((id): id is string => typeof id === 'string')
    : []

  const currentPage = (typeof body['currentPage'] === 'string'
    ? body['currentPage']
    : 'SearchResult') as CurrentPage

  const searchTerm = typeof body['searchTerm'] === 'string' ? body['searchTerm'] : undefined

  // Prior conversation turns, oldest first. Each turn has role ('user'|'bot') and content.
  const rawHistory = Array.isArray(body['history']) ? body['history'] : []
  const history = rawHistory.filter(
    (t): t is { role: 'user' | 'bot'; content: string } =>
      typeof t === 'object' && t !== null &&
      (t.role === 'user' || t.role === 'bot') &&
      typeof t.content === 'string',
  )

  // ── 2. Resolve identity and enforce usage limit ──────────────────────────

  const authHeader = c.req.header('Authorization')
  const sessionId  = c.req.header('X-Session-ID')

  const resolved = await resolveIdentity(authHeader, sessionId, secret)

  if (!resolved) {
    return c.json({ error: 'Provide Authorization: Bearer <token> or X-Session-ID header' }, 400)
  }

  const { identity, identityType, limit } = resolved
  const usage = await checkAndIncrementUsage(identity, identityType, limit)

  if (!usage.allowed) {
    const isSignedIn = identityType === 'user'
    return c.json(
      {
        limitReached: true,
        message: isSignedIn
          ? `You've used all ${LIMIT_SIGNED_IN} of your daily questions. Your limit resets at midnight UTC.`
          : `You've used all ${LIMIT_ANONYMOUS} of your daily questions. Sign in to get ${LIMIT_SIGNED_IN} questions per day.`,
      },
      429,
    )
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
  // Augment the query with the last bot turn when the current message is short
  // (e.g. "give me the link", "tell me more"). Short messages carry weak
  // semantic signal; the prior bot turn likely contains the resource name the
  // user is following up on, giving retrieval the context it needs.

  const lastBotMessage = [...history].reverse().find(t => t.role === 'bot')
  const ragQuery =
    message.length < 60 && lastBotMessage
      ? `${message} ${lastBotMessage.content}`
      : message

  let ragResources: Awaited<ReturnType<typeof retrieveForQuery>> = []
  try {
    // Exclude by resolved UUID: page context may have used legacy ids
    ragResources = await retrieveForQuery(ragQuery, RAG_K, pageContextResources.map(r => r.id))
  } catch (err) {
    // Non-fatal: fall back to page-context-only if embedding fails
    console.error('[chat] RAG retrieval failed, continuing without catalogue context:', err)
  }

  // ── 5. Assemble prompt and stream Gemini response ────────────────────────

  const systemPrompt = buildSystemPrompt(currentPage, searchTerm, pageContextResources, ragResources)

  const { queryDate } = usage

  return streamSSE(c, async (stream) => {
    // Whether any answer text reached the user. If Gemini fails before that,
    // the question is given back (refundUsage) so outages don't use up the
    // daily limit. A partial answer still counts.
    let answered = false
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

      const response = await ai.models.generateContentStream({
        model: MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
          maxOutputTokens: 8192,
        },
      })

      for await (const chunk of response) {
        const text = chunk.text
        if (text) {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'delta', content: text }),
          })
          answered = true
        }
      }

      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
    } catch (err) {
      console.error('[chat] Gemini streaming error:', err)
      if (!answered) {
        await refundUsage(identity, queryDate).catch((refundErr: unknown) => {
          console.error('[chat] failed to refund unanswered question:', refundErr)
        })
      }
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: 'Something went wrong. Please try again.' }),
      })
    }
  })
})
