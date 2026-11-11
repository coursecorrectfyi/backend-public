/**
 * lookupOnet — maps a course's extracted skill tags to O*NET occupations.
 *
 * Used by generateInsights() (M9.2) to ground AI insights with real-world
 * job titles, salary ranges, and employment outlook.
 *
 * Matching strategy:
 *   1. Exact match: LOWER(element_name) = ANY(normalizedSkills)
 *   2. Partial match: element_name ILIKE '%skill%' for any unmatched skills
 *   3. Rank occupations by average importance score of matched skills
 *   4. Return top 5 (excludes job_zone = 1: entry-level physical roles)
 */

import { sql } from 'drizzle-orm'
import { db } from '../../db/client.js'

export interface OnetMatch {
  socCode: string
  title: string
  description: string | null
  jobZone: number | null
  /** Normalized 0–1: average importance of matched skills ÷ 7 */
  matchScore: number
  medianAnnualSalary: number | null
  salaryRange: { p10: number; p90: number } | null
  growthCategory: string | null
}

/**
 * Returns the top O*NET occupation matches for a given list of skill names.
 * Returns an empty array if skills is empty or no matches are found.
 */
export async function lookupOnet(skills: string[]): Promise<OnetMatch[]> {
  if (!skills.length) return []

  const normalized = skills.map(s => s.toLowerCase().trim()).filter(Boolean)
  if (!normalized.length) return []

  // First pass: exact matches
  // Build an inline VALUES list for the skill terms — avoids array param issues
  // with Drizzle's sql template (which expands JS arrays as tuples, not PG arrays).
  const termValues = sql.join(normalized.map(t => sql`(${t})`), sql`, `)

  const exactRows = await db.execute<{
    soc_code: string
    title: string
    description: string | null
    job_zone: number | null
    avg_importance: number
    median_annual: number | null
    pct_10_annual: number | null
    pct_90_annual: number | null
    growth_category: string | null
  }>(sql`
    SELECT
      o.soc_code,
      o.title,
      o.description,
      jz.job_zone,
      AVG(s.data_value)                                   AS avg_importance,
      w.median_annual,
      w.pct_10_annual,
      w.pct_90_annual,
      w.growth_category
    FROM onet_occupations o
    JOIN onet_skills s
      ON s.soc_code = o.soc_code
      AND s.scale_id = 'IM'
      AND s.data_value >= 3.0
      AND LOWER(s.element_name) IN (SELECT t FROM (VALUES ${termValues}) AS v(t))
    LEFT JOIN onet_job_zones jz ON jz.soc_code = o.soc_code
    LEFT JOIN onet_wages     w  ON w.soc_code  = o.soc_code
    WHERE (jz.job_zone IS NULL OR jz.job_zone > 1)
    GROUP BY o.soc_code, o.title, o.description, jz.job_zone,
             w.median_annual, w.pct_10_annual, w.pct_90_annual, w.growth_category
    ORDER BY avg_importance DESC
    LIMIT 5
  `)

  if (exactRows.length >= 3) return toMatches(exactRows)

  // Second pass: broaden with partial matches
  const partialRows = await db.execute<{
    soc_code: string
    title: string
    description: string | null
    job_zone: number | null
    avg_importance: number
    median_annual: number | null
    pct_10_annual: number | null
    pct_90_annual: number | null
    growth_category: string | null
  }>(sql`
    SELECT
      o.soc_code,
      o.title,
      o.description,
      jz.job_zone,
      AVG(s.data_value)                                   AS avg_importance,
      w.median_annual,
      w.pct_10_annual,
      w.pct_90_annual,
      w.growth_category
    FROM onet_occupations o
    JOIN onet_skills s
      ON s.soc_code = o.soc_code
      AND s.scale_id = 'IM'
      AND s.data_value >= 3.0
      AND (
        LOWER(s.element_name) IN (SELECT t FROM (VALUES ${termValues}) AS v(t))
        OR EXISTS (
          SELECT 1 FROM (VALUES ${termValues}) AS v(term)
          WHERE s.element_name ILIKE '%' || term || '%'
        )
      )
    LEFT JOIN onet_job_zones jz ON jz.soc_code = o.soc_code
    LEFT JOIN onet_wages     w  ON w.soc_code  = o.soc_code
    WHERE (jz.job_zone IS NULL OR jz.job_zone > 1)
    GROUP BY o.soc_code, o.title, o.description, jz.job_zone,
             w.median_annual, w.pct_10_annual, w.pct_90_annual, w.growth_category
    ORDER BY avg_importance DESC
    LIMIT 5
  `)

  return toMatches(partialRows)
}

function toMatches(rows: {
  soc_code: string
  title: string
  description: string | null
  job_zone: number | null
  avg_importance: number
  median_annual: number | null
  pct_10_annual: number | null
  pct_90_annual: number | null
  growth_category: string | null
}[]): OnetMatch[] {
  return rows.map(r => ({
    socCode: r.soc_code,
    title: r.title,
    description: r.description,
    jobZone: r.job_zone,
    matchScore: Math.min(1, r.avg_importance / 7),
    medianAnnualSalary: r.median_annual,
    salaryRange: r.pct_10_annual != null && r.pct_90_annual != null
      ? { p10: r.pct_10_annual, p90: r.pct_90_annual }
      : null,
    growthCategory: r.growth_category,
  }))
}
