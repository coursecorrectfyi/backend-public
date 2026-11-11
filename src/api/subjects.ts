import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { topics } from '../db/schema.js'

// Orders topics so each domain is immediately followed by its subtopics, both
// in sort_order order. Domains have parent_id = null, so COALESCE(parent_id, id)
// gives the domain's own id for both the domain row and all its children —
// grouping them together. The secondary sort puts the domain row (parent_id IS NULL)
// before its subtopics, and the tertiary sort orders subtopics within the domain.
const HIERARCHICAL_ORDER = [
  sql`(SELECT t2.sort_order FROM topics t2 WHERE t2.id = COALESCE(${topics.parent_id}, ${topics.id}))`,
  sql`${topics.parent_id} NULLS FIRST`,
  topics.sort_order,
]

type TopicRow = {
  id: string
  name: string
  slug: string
  description: string | null
  meta_description: string | null
  parent_id: string | null
  sort_order: number | null
  course_count: number | null
}

// In-memory cache — topics change only on manual seed runs, so we cache for
// the lifetime of the process. Invalidated automatically on Cloud Run redeploy.
let cache: TopicRow[] | null = null

async function getAllTopics(): Promise<TopicRow[]> {
  if (cache) return cache
  cache = await db
    .select({
      id: topics.id,
      name: topics.name,
      slug: topics.slug,
      description: topics.description,
      meta_description: topics.meta_description,
      parent_id: topics.parent_id,
      sort_order: topics.sort_order,
      course_count: topics.course_count,
    })
    .from(topics)
    .orderBy(...HIERARCHICAL_ORDER)
  return cache
}

export const subjectsRouter = new Hono()

/**
 * GET /api/v1/subjects
 *
 * Returns a flat array of all topics (domains + subtopics) in hierarchical order:
 * each domain followed immediately by its subtopics, both ordered by sort_order.
 * Used by AppSearch autocomplete.
 */
subjectsRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(await getAllTopics())
})

/**
 * GET /api/v1/subjects/tree
 *
 * Returns the full two-level topic tree — all domains with their subtopics
 * nested inline. Ordered by sort_order at both levels.
 * Reserved for the header nav menu (M6.x).
 */
subjectsRouter.get('/tree', async (c) => {
  const all = await getAllTopics()

  const domainMap = new Map<string, TopicRow & { subtopics: TopicRow[] }>()
  const domains: Array<TopicRow & { subtopics: TopicRow[] }> = []

  for (const row of all) {
    if (row.parent_id === null) {
      const domain = { ...row, subtopics: [] as TopicRow[] }
      domainMap.set(row.id, domain)
      domains.push(domain)
    }
  }

  for (const row of all) {
    if (row.parent_id !== null) {
      const parent = domainMap.get(row.parent_id)
      if (parent) parent.subtopics.push(row)
    }
  }

  return c.json({ domains })
})

/**
 * GET /api/v1/subjects/:slug
 *
 * Returns a single topic by slug. If the slug is a domain (parent_id = null),
 * includes its subtopics array. If it's a subtopic, includes the parent domain.
 *
 * Used by the /subjects/:slug subject pages (M6.4).
 */
subjectsRouter.get('/:slug', async (c) => {
  const slug = c.req.param('slug')

  const [topic] = await db
    .select()
    .from(topics)
    .where(eq(topics.slug, slug))
    .limit(1)

  if (!topic) {
    return c.json({ error: 'Not found' }, 404)
  }

  if (topic.parent_id === null) {
    // Domain — attach subtopics
    const subtopics = await db
      .select({
        id: topics.id,
        name: topics.name,
        slug: topics.slug,
        description: topics.description,
        meta_description: topics.meta_description,
        sort_order: topics.sort_order,
        course_count: topics.course_count,
      })
      .from(topics)
      .where(eq(topics.parent_id, topic.id))
      .orderBy(topics.sort_order)

    return c.json({ topic, subtopics })
  }

  // Subtopic — attach parent domain
  const [parent] = await db
    .select({
      id: topics.id,
      name: topics.name,
      slug: topics.slug,
    })
    .from(topics)
    .where(eq(topics.id, topic.parent_id))
    .limit(1)

  return c.json({ topic, parent: parent ?? null })
})
