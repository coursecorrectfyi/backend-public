import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { saved_courses, learning_resources } from '../db/schema.js'
import { requireAuth } from './middleware/auth.js'
import { matchResourceId } from './resource-ids.js'

export const savedRouter = new Hono()

// All saved courses endpoints require authentication
savedRouter.use('*', requireAuth)

// ─── GET /api/v1/saved ────────────────────────────────────────────────────────
// Returns all saved resources for the authenticated user, ordered by most
// recently saved first.

savedRouter.get('/', async (c) => {
  const userId = c.var.userId

  const rows = await db
    .select({
      id:              learning_resources.id,
      provider:        learning_resources.provider,
      resource_type:   learning_resources.resource_type,
      provider_type:   learning_resources.provider_type,
      title:           learning_resources.title,
      ai_summary:      learning_resources.ai_summary,
      institution:     learning_resources.institution,
      language:        learning_resources.language,
      level:           learning_resources.level,
      duration_hours:  learning_resources.duration_hours,
      rating:          learning_resources.rating,
      num_ratings:     learning_resources.num_ratings,
      is_free:         learning_resources.is_free,
      has_certificate: learning_resources.has_certificate,
      is_self_paced:   learning_resources.is_self_paced,
      skills:          learning_resources.skills,
      career_paths:    learning_resources.career_paths,
      source_url:      learning_resources.source_url,
      affiliate_url:   learning_resources.affiliate_url,
      saved_at:        saved_courses.saved_at,
    })
    .from(saved_courses)
    .innerJoin(
      learning_resources,
      and(
        eq(saved_courses.resource_id, learning_resources.id),
        eq(learning_resources.is_active, true),
      ),
    )
    .where(eq(saved_courses.user_id, userId))
    // Newest first. This used to be oldest first; see "Frontend: saved courses
    // order" under To do in README.md.
    .orderBy(desc(saved_courses.saved_at))

  const data = rows.map(({ source_url, affiliate_url, ...rest }) => ({
    ...rest,
    url: affiliate_url ?? source_url,
  }))

  return c.json({ data })
})

// ─── POST /api/v1/saved/:resourceId ──────────────────────────────────────────
// Saves a resource for the authenticated user.
// Idempotent — saving an already-saved resource returns 200, not an error.
// :resourceId may be a UUID or a legacy MongoDB ID (TODO(legacy-mongo-ids));
// the resource's UUID is what gets stored.

savedRouter.post('/:resourceId', async (c) => {
  const userId = c.var.userId
  const match = matchResourceId(c.req.param('resourceId'))

  if (!match) {
    return c.json({ error: 'Resource not found' }, 404)
  }

  // Verify the resource exists and is active
  const [resource] = await db
    .select({ id: learning_resources.id })
    .from(learning_resources)
    .where(and(match, eq(learning_resources.is_active, true)))
    .limit(1)

  if (!resource) {
    return c.json({ error: 'Resource not found' }, 404)
  }

  // ON CONFLICT DO NOTHING makes this idempotent
  await db
    .insert(saved_courses)
    .values({ user_id: userId, resource_id: resource.id })
    .onConflictDoNothing()

  return c.json({ ok: true })
})

// ─── DELETE /api/v1/saved/:resourceId ────────────────────────────────────────
// Removes a saved resource for the authenticated user.
// Idempotent — removing a resource that isn't saved returns 200, not an error.
// :resourceId may be a UUID or a legacy MongoDB ID (TODO(legacy-mongo-ids)).

savedRouter.delete('/:resourceId', async (c) => {
  const userId = c.var.userId
  const match = matchResourceId(c.req.param('resourceId'))

  // An id in neither format can't have been saved, so there is nothing to remove.
  if (!match) {
    return c.json({ ok: true })
  }

  await db
    .delete(saved_courses)
    .where(
      and(
        eq(saved_courses.user_id, userId),
        inArray(
          saved_courses.resource_id,
          db.select({ id: learning_resources.id }).from(learning_resources).where(match),
        ),
      ),
    )

  return c.json({ ok: true })
})
