const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LEGACY_MONGO_ID_RE = /^[0-9a-f]{24}$/i

/**
 * True if `value` is a canonical UUID string.
 *
 * Check ids from URLs and request bodies before comparing them with a uuid
 * column: Postgres rejects malformed input ("invalid input syntax for type
 * uuid"), which would otherwise turn a simple not-found into a 500.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * True if `value` looks like a legacy MongoDB ObjectId (24 hex chars) from
 * CourseCorrect 1.0, stored in learning_resources.legacy_mongo_id.
 *
 * TODO(legacy-mongo-ids): remove once we've verified no client still sends
 * legacy ids (see "To do" in README.md). Search the code for this tag to find
 * every place that accepts them.
 */
export function isLegacyMongoId(value: string): boolean {
  return LEGACY_MONGO_ID_RE.test(value)
}
