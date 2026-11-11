/**
 * M9.2 — AI Insights Generation
 *
 * generateInsights(resourceId) fetches a learning resource + its reviews,
 * grounds the result with O*NET occupational data, then calls the configured
 * LLM provider to produce structured ai_insights stored on the learning_resources row.
 *
 * Two sections are always attempted:
 *   reviewInsights  — sentiment, pros/cons, representative quotes (skipped if no reviews)
 *   careerInsights  — job roles + salary ranges, complementary skills, growth outlook
 *
 * Called by:
 *   - M9.3 batch job (src/jobs/insights/batch.ts) for top resources
 *   - M9.4 on-demand trigger from course detail API
 */

import { eq, desc } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { learning_resources, course_reviews } from '../../db/schema.js'
import { lookupOnet } from '../onet/lookup.js'
import { log } from '../../lib/logger.js'
import { callLlm, type AiInsights } from './providers/index.js'

export { DailyQuotaExhaustedError } from './errors.js'
export type { AiInsights }

const MAX_REVIEWS = 50

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildPrompt(
  resource: {
    title: string
    provider: string
    institution: string | null
    level: string | null
    duration_hours: number | null
    rating: number | null
    num_ratings: number | null
    skills: string[] | null
    career_paths: string[] | null
    ai_summary: string | null
  },
  reviews: Array<{ author_name: string | null; rating: number | null; review_text: string | null }>,
  onetMatches: Awaited<ReturnType<typeof lookupOnet>>,
): string {
  const lines: string[] = []

  lines.push('## Course')
  lines.push(`Title: ${resource.title}`)
  lines.push(`Provider: ${resource.provider}`)
  if (resource.institution) lines.push(`Institution: ${resource.institution}`)
  if (resource.level) lines.push(`Level: ${resource.level}`)
  if (resource.duration_hours) lines.push(`Duration: ${resource.duration_hours} hours`)
  if (resource.rating) lines.push(`Rating: ${resource.rating.toFixed(1)}/5.0 (${resource.num_ratings?.toLocaleString() ?? 'unknown'} ratings)`)
  if (resource.ai_summary) lines.push(`Summary: ${resource.ai_summary}`)
  if (resource.skills?.length) lines.push(`Skills: ${resource.skills.join(', ')}`)
  if (resource.career_paths?.length) lines.push(`Career paths: ${resource.career_paths.join(', ')}`)

  if (reviews.length > 0) {
    lines.push('\n## Learner Reviews')
    for (const r of reviews) {
      const parts: string[] = []
      if (r.rating != null) parts.push(`${r.rating}/5`)
      if (r.author_name) parts.push(`— ${r.author_name}`)
      lines.push(parts.join(' '))
      if (r.review_text) lines.push(`"${r.review_text.slice(0, 500)}"`)
    }
  }

  if (onetMatches.length > 0) {
    lines.push('\n## Related Occupations (O*NET / BLS data)')
    for (const m of onetMatches) {
      const salary = m.medianAnnualSalary
        ? `median salary $${Math.round(m.medianAnnualSalary / 1000)}K/yr` +
          (m.salaryRange ? ` (range $${Math.round(m.salaryRange.p10 / 1000)}K–$${Math.round(m.salaryRange.p90 / 1000)}K)` : '')
        : 'salary data unavailable'
      const growth = m.growthCategory ? `; outlook: ${m.growthCategory}` : ''
      lines.push(`- ${m.title}: ${salary}${growth}`)
    }
  }

  lines.push('\n## Instructions')
  lines.push('Generate structured insights for this learning resource.')
  lines.push('')
  lines.push('reviewInsights: Synthesize the learner reviews above.')
  lines.push('  - sentiment: overall tone across all reviews')
  lines.push('  - pros: 3–5 concrete recurring positives (specific, not generic)')
  lines.push('  - cons: 2–4 concrete recurring negatives or caveats')
  lines.push('  - representative_quotes: 2–3 verbatim or near-verbatim quotes that best capture learner experience')
  lines.push('  - If no reviews are provided, return null for reviewInsights.')
  lines.push('')
  lines.push('careerInsights: Ground career outcomes using the O*NET data above where available.')
  lines.push('  - job_roles: 3–5 realistic roles. Use BLS salary data for salary_range (format: "$73K–$125K/yr"). If BLS data is missing, estimate from context.')
  lines.push('  - complementary_skills: 3–5 skills that pair well with the course content')
  lines.push('  - growth_potential: 1–2 sentences on career trajectory and market demand. Use BLS outlook category if available.')

  return lines.join('\n')
}

// ── Core function ──────────────────────────────────────────────────────────────

/**
 * Generates AI insights for a learning resource and persists them to the DB.
 * Idempotent: safe to call multiple times; each call overwrites the previous result.
 *
 * @throws If the resource is not found or the LLM fails after all retries.
 */
export async function generateInsights(resourceId: string): Promise<void> {
  // 1. Fetch resource
  const [resource] = await db
    .select({
      id: learning_resources.id,
      title: learning_resources.title,
      provider: learning_resources.provider,
      institution: learning_resources.institution,
      level: learning_resources.level,
      duration_hours: learning_resources.duration_hours,
      rating: learning_resources.rating,
      num_ratings: learning_resources.num_ratings,
      skills: learning_resources.skills,
      career_paths: learning_resources.career_paths,
      ai_summary: learning_resources.ai_summary,
    })
    .from(learning_resources)
    .where(eq(learning_resources.id, resourceId))
    .limit(1)

  if (!resource) throw new Error(`Resource not found: ${resourceId}`)

  // 2. Fetch up to MAX_REVIEWS reviews (most recent, non-empty)
  const reviews = await db
    .select({
      author_name: course_reviews.author_name,
      rating: course_reviews.rating,
      review_text: course_reviews.review_text,
    })
    .from(course_reviews)
    .where(eq(course_reviews.resource_id, resourceId))
    .orderBy(desc(course_reviews.review_date))
    .limit(MAX_REVIEWS)

  // 3. O*NET lookup for career grounding
  const onetMatches = await lookupOnet(resource.skills ?? [])

  log({
    event: 'insights_generating',
    resource_id: resourceId,
    title: resource.title,
    reviews: reviews.length,
    onet_matches: onetMatches.length,
  })

  // 4. Build prompt and call LLM
  const prompt = buildPrompt(resource, reviews, onetMatches)
  const insights = await callLlm(prompt)

  // 5. Upsert ai_insights onto the learning_resources row
  // Schema type uses undefined for optional fields; convert null → undefined
  await db
    .update(learning_resources)
    .set({
      ai_insights: {
        ...insights,
        reviewInsights: insights.reviewInsights ?? undefined,
      },
      ai_insights_updated_at: new Date(),
    })
    .where(eq(learning_resources.id, resourceId))

  log({
    event: 'insights_generated',
    resource_id: resourceId,
    sentiment: insights.reviewInsights?.sentiment ?? 'no_reviews',
    job_roles: insights.careerInsights.job_roles.length,
  })
}
