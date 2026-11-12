import { eq, inArray, or, type SQL } from 'drizzle-orm'
import { learning_resources } from '../db/schema.js'
import { isLegacyMongoId, isUuid } from '../lib/ids.js'

/**
 * WHERE condition matching learning_resources by either id format the API
 * accepts: a UUID (learning_resources.id) or a legacy MongoDB ObjectId
 * (learning_resources.legacy_mongo_id).
 *
 * Ids in neither format are dropped: comparing them with the uuid column would
 * make Postgres throw. Returns null when no id is usable, so callers can
 * answer "not found" without querying.
 *
 * TODO(legacy-mongo-ids): once legacy ids are retired, this reduces to
 * inArray(learning_resources.id, ids.filter(isUuid)).
 */
export function matchResourceIds(ids: string[]): SQL | null {
  const uuids = ids.filter(isUuid)
  const legacyIds = ids.filter(isLegacyMongoId)
  const conditions = [
    ...(uuids.length ? [inArray(learning_resources.id, uuids)] : []),
    ...(legacyIds.length ? [inArray(learning_resources.legacy_mongo_id, legacyIds)] : []),
  ]
  if (conditions.length === 0) return null
  return conditions.length === 1 ? conditions[0]! : or(...conditions)!
}

/** Single-id form of matchResourceIds(). */
export function matchResourceId(id: string): SQL | null {
  if (isUuid(id)) return eq(learning_resources.id, id)
  if (isLegacyMongoId(id)) return eq(learning_resources.legacy_mongo_id, id)
  return null
}
