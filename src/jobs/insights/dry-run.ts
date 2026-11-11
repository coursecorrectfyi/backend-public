/**
 * Dry-run for generateInsights — runs on a single resource and prints the result.
 *
 * Usage:
 *   npm run insights:dry
 *   RESOURCE_ID=<uuid> npm run insights:dry   # target a specific resource
 */

import 'dotenv/config'
import { desc, sql, isNotNull } from 'drizzle-orm'
import { db, closeDb } from '../../db/client.js'
import { learning_resources } from '../../db/schema.js'
import { generateInsights } from './generate.js'
import { log } from '../../lib/logger.js'

async function main() {
  let resourceId = process.env.RESOURCE_ID ?? null

  if (!resourceId) {
    // Pick the resource with the most reviews that also has skills
    const [candidate] = await db
      .select({
        id: learning_resources.id,
        title: learning_resources.title,
        provider: learning_resources.provider,
        review_count: sql<number>`(select count(*) from course_reviews where resource_id = ${learning_resources.id})::int`,
      })
      .from(learning_resources)
      .where(isNotNull(learning_resources.skills))
      .orderBy(desc(sql`(select count(*) from course_reviews where resource_id = ${learning_resources.id})`))
      .limit(1)

    if (!candidate) throw new Error('No resources with skills found in DB')

    resourceId = candidate.id
    log({ event: 'insights_dry_run_target', id: resourceId, title: candidate.title, provider: candidate.provider, reviews: candidate.review_count })
  }

  await generateInsights(resourceId)

  // Print the result
  const [result] = await db
    .select({ ai_insights: learning_resources.ai_insights })
    .from(learning_resources)
    .where(sql`id = ${resourceId}`)
    .limit(1)

  console.log('\n── ai_insights ──────────────────────────────────────────')
  console.log(JSON.stringify(result?.ai_insights, null, 2))

  await closeDb()
}

main().catch(err => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
