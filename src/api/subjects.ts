import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { topics } from '../db/schema.js'
import { registerInstanceState } from '../lib/instance-state.js'
import { logError } from '../lib/logger.js'

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

type FullTopic = typeof topics.$inferSelect

// ─── In-memory snapshot of the taxonomy ───────────────────────────────────────
//
// Topics change only when the taxonomy is seeded, and there are a few hundred
// at most, so every subjects endpoint is served from one snapshot of the whole
// table instead of querying per request (an unknown slug costs nothing either).
//
// - Refreshed at most every SUBJECTS_CACHE_MS (10 min) per instance: a seed run
//   shows up within 10 minutes, without a redeploy. Simultaneous requests
//   share one refresh.
// - If a refresh fails and there is an older snapshot, the older one is served
//   (subject pages keep working during a database outage) and the refresh is
//   retried after SUBJECTS_RETRY_MS. Without any snapshot, the error goes to
//   the app's error handler (500).
// - Responses also carry Cache-Control (SUBJECTS_CACHE_CONTROL), so browsers
//   reuse them for 5 minutes. Worst case after a seed: about 15 minutes.

export const SUBJECTS_CACHE_MS = 10 * 60_000
export const SUBJECTS_RETRY_MS = 30_000
export const SUBJECTS_CACHE_CONTROL = 'public, max-age=300'

interface Snapshot {
  /** Every topic (full row), in hierarchical order */
  rows: FullTopic[]
  bySlug: Map<string, FullTopic>
  byId: Map<string, FullTopic>
  /** Direct children per parent id, by sort_order (nulls last) */
  children: Map<string, FullTopic[]>
}

let snapshot: Snapshot | null = null
let nextRefreshAt = 0
let refreshing: Promise<Snapshot> | null = null

registerInstanceState(() => {
  snapshot = null
  nextRefreshAt = 0
  refreshing = null
})

function buildSnapshot(rows: FullTopic[]): Snapshot {
  const children = new Map<string, FullTopic[]>()
  for (const row of rows) {
    if (row.parent_id === null) continue
    const siblings = children.get(row.parent_id) ?? []
    siblings.push(row)
    children.set(row.parent_id, siblings)
  }
  // Same order as ORDER BY sort_order (ascending, nulls last). The sort is
  // stable, so topics with the same (or no) sort_order keep the snapshot order.
  const bySortOrder = (a: FullTopic, b: FullTopic) => {
    if (a.sort_order === b.sort_order) return 0
    if (a.sort_order === null) return 1
    if (b.sort_order === null) return -1
    return a.sort_order - b.sort_order
  }
  for (const siblings of children.values()) siblings.sort(bySortOrder)
  return {
    rows,
    bySlug: new Map(rows.map(r => [r.slug, r])),
    byId: new Map(rows.map(r => [r.id, r])),
    children,
  }
}

async function refreshSnapshot(): Promise<Snapshot> {
  try {
    const rows = await db.select().from(topics).orderBy(...HIERARCHICAL_ORDER)
    snapshot = buildSnapshot(rows)
    nextRefreshAt = Date.now() + SUBJECTS_CACHE_MS
    return snapshot
  } catch (err) {
    if (!snapshot) throw err
    logError('subjects_refresh_failed', err)
    nextRefreshAt = Date.now() + SUBJECTS_RETRY_MS
    return snapshot // serve the older taxonomy rather than fail
  }
}

async function getSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() < nextRefreshAt) return snapshot
  if (!refreshing) {
    const refresh = refreshSnapshot()
    refreshing = refresh
    // Cleared in a callback, which always runs after the assignment above. (A
    // `finally` block inside refreshSnapshot would run before it when the
    // query fails synchronously, and leave the failed refresh in place forever.)
    const done = () => { if (refreshing === refresh) refreshing = null }
    refresh.then(done, done)
  }
  return refreshing
}

/** The fields the list endpoints return for each topic. */
function listFields(row: FullTopic): TopicRow {
  const { id, name, slug, description, meta_description, parent_id, sort_order, course_count } = row
  return { id, name, slug, description, meta_description, parent_id, sort_order, course_count }
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
  const { rows } = await getSnapshot()
  c.header('Cache-Control', SUBJECTS_CACHE_CONTROL)
  return c.json(rows.map(listFields))
})

/**
 * GET /api/v1/subjects/tree
 *
 * Returns the full two-level topic tree — all domains with their subtopics
 * nested inline. Ordered by sort_order at both levels.
 * Reserved for the header nav menu (M6.x).
 */
subjectsRouter.get('/tree', async (c) => {
  const all = (await getSnapshot()).rows.map(listFields)

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

  c.header('Cache-Control', SUBJECTS_CACHE_CONTROL)
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
  const { bySlug, byId, children } = await getSnapshot()
  const topic = bySlug.get(c.req.param('slug'))

  if (!topic) {
    return c.json({ error: 'Not found' }, 404)
  }

  c.header('Cache-Control', SUBJECTS_CACHE_CONTROL)

  if (topic.parent_id === null) {
    // Domain — attach subtopics
    const subtopics = (children.get(topic.id) ?? []).map(
      ({ id, name, slug, description, meta_description, sort_order, course_count }) =>
        ({ id, name, slug, description, meta_description, sort_order, course_count }),
    )
    return c.json({ topic, subtopics })
  }

  // Subtopic — attach parent domain
  const parent = byId.get(topic.parent_id)
  return c.json({ topic, parent: parent ? { id: parent.id, name: parent.name, slug: parent.slug } : null })
})
