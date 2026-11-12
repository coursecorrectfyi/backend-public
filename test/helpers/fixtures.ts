/** Builders for test data. Each inserts valid rows with overridable defaults. */
import { sql } from 'drizzle-orm'
import { db } from '../fakes/db.js'
import { learning_resources, topics, saved_courses, chat_usage, users } from '../../src/db/schema.js'

let seq = 0
const next = () => ++seq

type ResourceInsert = typeof learning_resources.$inferInsert
type TopicInsert = typeof topics.$inferInsert

export async function insertResource(overrides: Partial<ResourceInsert> = {}) {
  const n = next()
  const [row] = await db
    .insert(learning_resources)
    .values({
      provider: 'coursera',
      external_id: `ext-${n}`,
      resource_type: 'course',
      title: `Resource ${n}`,
      source_url: `https://provider.example/course/${n}`,
      last_seen_at: 1_700_000_000_000,
      ...overrides,
    })
    .returning()
  return row!
}

export async function insertResources(list: Array<Partial<ResourceInsert>>) {
  const rows = []
  for (const overrides of list) rows.push(await insertResource(overrides))
  return rows
}

export async function insertTopic(overrides: Partial<TopicInsert> = {}) {
  const n = next()
  const [row] = await db
    .insert(topics)
    .values({ name: `Topic ${n}`, slug: `topic-${n}`, ...overrides })
    .returning()
  return row!
}

export async function saveCourse(userId: string, resourceId: string, savedAt?: Date) {
  await db.insert(saved_courses).values({ user_id: userId, resource_id: resourceId, ...(savedAt ? { saved_at: savedAt } : {}) })
}

export async function savedResourceIds(userId: string): Promise<string[]> {
  const rows = await db.select().from(saved_courses).where(sql`${saved_courses.user_id} = ${userId}`)
  return rows.map(r => r.resource_id)
}

/** Sets today's chat usage count for an identity (today = the database's CURRENT_DATE, like the app). */
export async function setChatUsage(identity: string, identityType: 'user' | 'anon', count: number) {
  await db.insert(chat_usage).values({ identity, identity_type: identityType, query_date: sql`CURRENT_DATE`, count })
}

/** Today's chat usage count for an identity (0 if none). */
export async function chatUsageToday(identity: string): Promise<number> {
  const rows = await db
    .select({ count: chat_usage.count })
    .from(chat_usage)
    .where(sql`${chat_usage.identity} = ${identity} AND ${chat_usage.query_date} = CURRENT_DATE`)
  return rows[0]?.count ?? 0
}

export async function allUsers() {
  return db.select().from(users)
}
