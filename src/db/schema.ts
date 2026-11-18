import {
  pgTable,
  uuid,
  text,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  timestamp,
  bigint,
  date,
  primaryKey,
  index,
  unique,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ─── Custom column types ──────────────────────────────────────────────────────

/**
 * pgvector `halfvec`: 16-bit floats, half the size of `vector` (float4). A
 * 768-dimension embedding is ~1.5 KB, small enough to stay in the row
 * instead of TOAST, and the HNSW index is half the size. Ranking is the same
 * in practice (measured on the catalogue: docs/deployment-gcp.md, "halfvec").
 * Written and read as text ('[0.1,0.2,…]'), like `vector`.
 */
const halfvec = customType<{ data: number[]; config: { dimensions: number } }>({
  dataType(config) {
    return `halfvec(${config?.dimensions ?? 768})`
  },
  toDriver(value: number[]) {
    return JSON.stringify(value)
  },
  fromDriver(value: unknown) {
    if (typeof value === 'string') return JSON.parse(value) as number[]
    return value as number[]
  },
})

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

// ─── Ingestion runs ───────────────────────────────────────────────────────────
// Written by the catalogue ingestion pipeline, which is not part of this repository.

/**
 * One row per ingestion run (per provider).
 * Used for observability: success/failure counts, run history.
 */
export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  /** 'coursera' | 'udemy' | 'edx' | 'pluralsight' | 'skillshare' */
  provider: text('provider').notNull(),
  status: text('status').$type<'running' | 'completed' | 'failed' | 'partial'>().notNull(),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  total_urls: integer('total_urls'),
  success_count: integer('success_count'),
  failure_count: integer('failure_count'),
  /** Free-text notes, e.g. reason for partial/failed status */
  notes: text('notes'),
})

/**
 * One row per item processed within an ingestion run.
 */
export const run_results = pgTable('run_results', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  run_id: uuid('run_id').notNull().references(() => runs.id),
  url: text('url').notNull(),
  outcome: text('outcome').$type<'success' | 'failure' | 'skipped'>().notNull(),
  /** 'http_error' | 'parse_error' | 'timeout' | 'extraction_error' */
  error_type: text('error_type'),
  error_message: text('error_message'),
  html_snapshot_key: text('html_snapshot_key'),
  processed_at: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('run_results_run_id_outcome_idx').on(table.run_id, table.outcome),
])

// ─── Topics ───────────────────────────────────────────────────────────────────

/**
 * First-class entities representing skill domains / subject areas.
 * Powers /subjects/{slug} SEO pages and resource filtering.
 * CC 2.0 will use topics as the unit of skill gap analysis in personalized roadmaps.
 * cross_provider_insights is reserved for CC 2.0: synthesized insights from all
 * learners who studied a topic (e.g. "fastest path to learn Python for data science").
 */
export const topics = pgTable('topics', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  /** Display name, e.g. 'Python for Data Science' */
  name: text('name').notNull().unique(),
  /** URL slug, e.g. 'python-for-data-science' — used in /subjects/{slug} */
  slug: text('slug').notNull().unique(),
  /** User-facing topic description shown on subject pages */
  description: text('description'),
  /** Reference to a broader parent topic (e.g. 'Data Science' is parent of 'Python for DS') */
  parent_id: uuid('parent_id').references((): AnyPgColumn => topics.id),
  /** SEO meta description for the subject page */
  meta_description: text('meta_description'),
  /**
   * Display order within a parent group (lower = shown first).
   * Top-level domains are ordered globally; leaf topics are ordered within their parent.
   * Set at seed time; update manually or via analytics-driven re-ranking.
   */
  sort_order: integer('sort_order'),
  /**
   * Cached count of active courses for this topic. Updated periodically.
   * Used for "1,234 courses" display on topic cards and for ranking by volume.
   * Null until first populated.
   */
  course_count: integer('course_count'),
  /**
   * CC 2.0: aggregated insights synthesized across all resources in this topic.
   * Shape: { bestPaths: [...], commonPitfalls: [...], topResources: [...] }
   */
  cross_provider_insights: jsonb('cross_provider_insights'),
  insights_updated_at: timestamp('insights_updated_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('topics_slug_idx').on(table.slug),
  index('topics_parent_id_idx').on(table.parent_id),
])

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * Minimal user table. Authentication is handled by Firebase Auth — this table
 * exists for application-level data (saved courses, and future CC 2.0 profile fields).
 * CC 2.0 will add: career_history JSONB, goals JSONB, skill_profile JSONB.
 */
export const users = pgTable('users', {
  /** Firebase UID — primary key, matches the sub claim in Firebase ID tokens */
  firebase_uid: text('firebase_uid').primaryKey(),
  email: text('email'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ─── Raw ingestion layer ──────────────────────────────────────────────────────

/**
 * One row per ingested catalogue item, before normalization.
 * Written by the ingestion pipeline (not part of this repository).
 * Never read directly by the frontend.
 */
export const learning_resources_raw = pgTable('learning_resources_raw', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  /** 'coursera' | 'udemy' | 'edx' | 'pluralsight' | 'skillshare' */
  provider: text('provider').notNull(),
  /** Provider-specific page identifier (slug, numeric ID, etc.) */
  external_id: text('external_id').notNull(),
  /** Canonical provider URL, e.g. https://www.coursera.org/learn/machine-learning */
  source_url: text('source_url').notNull(),
  /** The run that collected this page (nullable: can be set to null for manually ingested rows) */
  run_id: uuid('run_id').references(() => runs.id),
  html_gcs_key: text('html_gcs_key').notNull(),
  /** Structured data for this item; null until it has been processed */
  extracted_data: jsonb('extracted_data'),
  scraped_at: timestamp('scraped_at', { withTimezone: true }).notNull().defaultNow(),
  extracted_at: timestamp('extracted_at', { withTimezone: true }),
}, (table) => [
  unique('lrr_provider_external_id').on(table.provider, table.external_id),
])

// ─── Normalized user-facing layer ─────────────────────────────────────────────

/**
 * The user-facing course/program/degree/project catalogue.
 * All fields are AI-normalized — no verbatim provider marketing copy.
 * Powers search, detail pages, and AI chat (RAG).
 *
 * Populated by the ingestion pipeline (not part of this repository) from
 * learning_resources_raw.
 */
export const learning_resources = pgTable('learning_resources', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  /** The raw ingestion row this was normalized from */
  raw_id: uuid('raw_id').references(() => learning_resources_raw.id),

  // ── Identity ────────────────────────────────────────────────────────────────
  /** 'coursera' | 'udemy' | 'edx' | 'pluralsight' | 'skillshare' */
  provider: text('provider').notNull(),
  /** Provider-specific identifier (matches learning_resources_raw.external_id) */
  external_id: text('external_id').notNull(),
  /** Original provider label, e.g. 'Specialization', 'MasterTrack', 'Guided Project' */
  provider_type: text('provider_type'),
  /** Legacy MongoDB _id from CC 1.0 — preserved for backlink compatibility */
  legacy_mongo_id: text('legacy_mongo_id'),

  // ── User-facing type taxonomy ────────────────────────────────────────────────
  /**
   * Normalized type taxonomy (see PRD for provider → type mapping).
   * Taxonomy is still being finalized — see docs/cc-1.5/PRD.md provider analysis.
   * 'course' | 'program' | 'degree' | 'project'
   */
  resource_type: text('resource_type')
    .$type<'course' | 'program' | 'degree' | 'project' | 'certification' | 'code_along'>()
    .notNull(),

  // ── Normalized metadata (AI-generated; not provider marketing copy) ──────────
  title: text('title').notNull(),
  /** 2–3 factual sentences: what you learn and who it's for. No marketing language. */
  ai_summary: text('ai_summary'),
  /** Offering institution, e.g. 'Stanford University', 'Google', 'Meta' */
  institution: text('institution'),
  language: text('language'),
  /** 'beginner' | 'intermediate' | 'advanced' | 'all_levels' */
  level: text('level').$type<'beginner' | 'intermediate' | 'advanced' | 'all_levels'>(),
  /** Total hours, normalized from any provider format ("4 weeks, 3–5h/week" → 18.0) */
  duration_hours: doublePrecision('duration_hours'),
  /** 0.0–5.0. Overridden by JSON-LD aggregateRating when present. */
  rating: doublePrecision('rating'),
  /** Overridden by JSON-LD aggregateRating.reviewCount when present. */
  num_ratings: integer('num_ratings'),
  is_free: boolean('is_free'),
  has_certificate: boolean('has_certificate'),
  is_self_paced: boolean('is_self_paced'),

  // ── AI-extracted arrays ──────────────────────────────────────────────────────
  /** Normalized, de-duplicated skill tags extracted by Gemini (not provider-chosen labels) */
  skills: text('skills').array(),
  /** 2–4 job roles this learning prepares for, e.g. ['Data Scientist', 'ML Engineer'] */
  career_paths: text('career_paths').array(),

  // ── AI insights (generated separately; see Insights Generation in ARCHITECTURE.md) ──
  /**
   * Shape: {
   *   reviewInsights?: { sentiment, pros[], cons[], representative_quotes[] },
   *   careerInsights?: { job_roles[{ title, salary_range, description }], complementary_skills[], growth_potential }
   * }
   * Null until generated (either batch for top courses, or on-demand on first page view).
   */
  ai_insights: jsonb('ai_insights').$type<{
    reviewInsights?: {
      sentiment: 'positive' | 'mixed' | 'negative'
      pros: string[]
      cons: string[]
      representative_quotes: string[]
    }
    careerInsights?: {
      job_roles: Array<{ title: string; salary_range: string; description: string }>
      complementary_skills: string[]
      growth_potential: string
    }
  }>(),
  ai_insights_updated_at: timestamp('ai_insights_updated_at', { withTimezone: true }),

  // ── Search infrastructure ────────────────────────────────────────────────────
  /**
   * Weighted tsvector for full-text search. Maintained by a DB trigger on
   * INSERT/UPDATE of title, ai_summary, skills, institution, provider.
   * Weights: title=A, ai_summary+skills=B, institution+provider=C.
   */
  search_document: tsvector('search_document'),
  /**
   * Vertex AI text-embedding-004, 768 dimensions, stored as halfvec.
   * Input: "{title} | {provider_type} | {institution} | {level} | {skills} | {ai_summary}"
   * Queried by cosine distance through the HNSW index (lr_embedding_hnsw_idx).
   * Compare it with an uncast parameter (`embedding <=> ${literal}`): the
   * parameter then takes the column's type, and the index is used.
   */
  embedding: halfvec('embedding', { dimensions: 768 }),

  // ── URLs ─────────────────────────────────────────────────────────────────────
  /** Canonical provider URL. Used for SEO canonical tags and as click fallback. */
  source_url: text('source_url').notNull(),
  /**
   * Impact affiliate tracking link. Used as the outbound click href when present.
   * Null if the provider is not in Impact's partner network (e.g. Skillshare).
   * Built by the ingestion pipeline from the provider's affiliate program config.
   */
  affiliate_url: text('affiliate_url'),

  // ── Operational ──────────────────────────────────────────────────────────────
  /**
   * Whether this resource is visible to users. Set to false when a full provider
   * run completes and this resource was not seen (last_seen_at < run.started_at).
   * Soft-deleted resources are excluded from search, listings, and AI chat.
   * Hard deletion is a separate manual/batch step after confirming removal.
   */
  is_active: boolean('is_active').notNull().default(true),
  /**
   * Epoch ms of the last ingestion run that saw this resource.
   * After each full provider run: mark is_active=false where last_seen_at < run.started_at.
   */
  last_seen_at: bigint('last_seen_at', { mode: 'number' }).notNull(),
  last_normalized_at: timestamp('last_normalized_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('lr_provider_external_id').on(table.provider, table.external_id),
  index('lr_search_document_idx').using('gin', table.search_document),
  index('lr_provider_idx').on(table.provider),
  index('lr_resource_type_idx').on(table.resource_type),
  index('lr_level_idx').on(table.level),
  index('lr_rating_idx').on(table.rating),
  index('lr_is_free_idx').on(table.is_free),
  index('lr_has_certificate_idx').on(table.has_certificate),
  index('lr_last_seen_at_idx').on(table.last_seen_at),
  index('lr_is_active_idx').on(table.is_active),
  index('lr_embedding_hnsw_idx').using('hnsw', table.embedding.op('halfvec_cosine_ops')),
])

/**
 * Many-to-many between learning_resources and topics.
 * relevance_score (0.0–1.0) indicates how central the topic is to the resource
 * (e.g. a Python course scores higher on 'Python' than on 'Data Science').
 */
export const resource_topics = pgTable('resource_topics', {
  resource_id: uuid('resource_id')
    .notNull()
    .references(() => learning_resources.id, { onDelete: 'cascade' }),
  topic_id: uuid('topic_id')
    .notNull()
    .references(() => topics.id, { onDelete: 'cascade' }),
  /** How central this topic is to the resource. 1.0 = primary topic. */
  relevance_score: doublePrecision('relevance_score').notNull().default(1.0),
}, (table) => [
  primaryKey({ columns: [table.resource_id, table.topic_id] }),
  index('resource_topics_topic_id_idx').on(table.topic_id),
])

// ─── Reviews ──────────────────────────────────────────────────────────────────

/**
 * Raw reviews per resource. Used as input for AI insight generation
 * (review synthesis). Not displayed directly to users — only the synthesized
 * ai_insights on learning_resources are shown.
 *
 * Dedup key: (resource_id, provider_review_id). provider_review_id is the
 * provider's own review identifier. When null (rare),
 * duplicate prevention is best-effort — we accept the trade-off over blocking
 * valid reviews with coincidentally matching author display names.
 */
export const course_reviews = pgTable('course_reviews', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  resource_id: uuid('resource_id')
    .notNull()
    .references(() => learning_resources.id, { onDelete: 'cascade' }),
  /** Provider's own review identifier. Used for dedup. */
  provider_review_id: text('provider_review_id'),
  /** Reviewer display name as shown on the provider page (e.g. 'John D.', 'Learner from India') */
  author_name: text('author_name'),
  /** 0.0–5.0 */
  rating: doublePrecision('rating'),
  review_date: date('review_date'),
  review_text: text('review_text'),
  helpful_count: integer('helpful_count'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('cr_resource_provider_review').on(table.resource_id, table.provider_review_id),
  index('course_reviews_resource_id_idx').on(table.resource_id),
])

// ─── O*NET reference data ─────────────────────────────────────────────────────

/**
 * O*NET occupations — one row per SOC code (~900 occupations).
 * Source: Occupation Data.txt from the O*NET database download.
 * Used by lookupOnet() to map course skills → job titles + salary/outlook.
 */
export const onet_occupations = pgTable('onet_occupations', {
  /** Standard Occupational Classification code, e.g. '15-1252.00' */
  soc_code: text('soc_code').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
})

/**
 * Skill importance and level ratings per occupation.
 * Source: Skills.txt. scale_id: 'IM' = importance (0–7), 'LV' = level (0–7).
 * Used to match a course's extracted skills against occupation requirements.
 */
export const onet_skills = pgTable('onet_skills', {
  soc_code: text('soc_code').notNull().references(() => onet_occupations.soc_code),
  element_name: text('element_name').notNull(),
  /** 'IM' (importance) or 'LV' (level) */
  scale_id: text('scale_id').notNull(),
  /** 0.0–7.0 */
  data_value: doublePrecision('data_value').notNull(),
}, (table) => [
  primaryKey({ columns: [table.soc_code, table.element_name, table.scale_id] }),
  index('onet_skills_soc_code_idx').on(table.soc_code),
  index('onet_skills_element_name_idx').on(table.element_name),
])

/**
 * Job zone (preparation level) per occupation.
 * Source: Job Zones.txt. Scale: 1 (little prep) to 5 (extensive prep).
 * Used as a proxy for career transition difficulty in AI insights.
 */
export const onet_job_zones = pgTable('onet_job_zones', {
  soc_code: text('soc_code').primaryKey().references(() => onet_occupations.soc_code),
  /** 1 = little prep required, 5 = extensive prep required */
  job_zone: integer('job_zone').notNull(),
})

/**
 * Wage and employment outlook per occupation.
 * Source: merged from O*NET/BLS OEWS data in the O*NET download.
 * Provides salary ranges and 10-year growth projections for AI insights.
 */
export const onet_wages = pgTable('onet_wages', {
  soc_code: text('soc_code').primaryKey().references(() => onet_occupations.soc_code),
  /** Median annual wage in USD */
  median_annual: integer('median_annual'),
  /** 10th percentile annual wage */
  pct_10_annual: integer('pct_10_annual'),
  /** 90th percentile annual wage */
  pct_90_annual: integer('pct_90_annual'),
  /** Projected 10-year employment growth as a decimal, e.g. 0.25 = 25% */
  growth_rate: doublePrecision('growth_rate'),
  /** BLS category, e.g. 'Much faster than average', 'Faster than average' */
  growth_category: text('growth_category'),
})

// ─── Chat usage ───────────────────────────────────────────────────────────────

/** Kinds of chat_usage counters (see chat_usage below). */
export type ChatUsageIdentityType = 'user' | 'anon' | 'ip' | 'global'

/**
 * Daily chat question counters, used to enforce the /api/v1/chat limits
 * (src/api/chat-usage.ts). One row per (identity, date); an UPSERT increments it.
 *
 * identity / identity_type:
 *   'user'   Firebase UID of a signed-in user                     (10/day)
 *   'anon'   anonymous session id: a lowercase UUID the browser
 *            generates and sends in X-Session-ID                   (5/day)
 *   'ip'     'ip:<HMAC of date + client IP>' shared by all anonymous
 *            sessions from one IP (IPv6: one /64). Never a raw IP   (ANON_IP_DAILY_LIMIT)
 *   'global' 'global:anon', all anonymous questions together       (ANON_GLOBAL_DAILY_LIMIT)
 *            'global:signed_in', all signed-in questions together  (SIGNED_IN_GLOBAL_DAILY_LIMIT)
 *
 * Analytics: count people with identity_type IN ('user', 'anon') only; 'ip'
 * and 'global' rows are extra counters for the same questions. Rows are kept
 * 7 days (retention job); daily totals stay in chat_usage_daily.
 */
export const chat_usage = pgTable('chat_usage', {
  /** See the table comment: Firebase UID, session UUID, 'ip:<hash>', 'global:anon' or 'global:signed_in' */
  identity: text('identity').notNull(),
  /** 'user' | 'anon' | 'ip' | 'global' (see the table comment) */
  identity_type: text('identity_type').$type<ChatUsageIdentityType>().notNull(),
  /** UTC calendar date — one row per identity per day */
  query_date: date('query_date').notNull(),
  /** Number of chat queries made on this date. Incremented atomically via UPSERT. */
  count: integer('count').notNull().default(1),
}, (table) => [
  primaryKey({ columns: [table.identity, table.query_date] }),
  index('chat_usage_date_idx').on(table.query_date),
])

/**
 * Daily totals kept after chat_usage rows are deleted (retention job,
 * src/lib/chat-usage-retention.ts). Counts only: no identities, no hashes.
 *
 * One row per (date, identity_type):
 *   'user'  identities = signed-in users who asked,      questions = their questions
 *   'anon'  identities = anonymous sessions that asked,  questions = their questions
 *   'ip'    identities = networks anonymous questions came from (distinct IPs / IPv6 /64s),
 *           questions = the same anonymous questions again: never add them to 'anon'
 */
export const chat_usage_daily = pgTable('chat_usage_daily', {
  query_date: date('query_date').notNull(),
  identity_type: text('identity_type').$type<'user' | 'anon' | 'ip'>().notNull(),
  identities: integer('identities').notNull(),
  questions: integer('questions').notNull(),
}, (table) => [
  primaryKey({ columns: [table.query_date, table.identity_type] }),
])

// ─── Saved courses ────────────────────────────────────────────────────────────

/** User's saved/bookmarked resources. */
export const saved_courses = pgTable('saved_courses', {
  /** Firebase UID */
  user_id: text('user_id').notNull(),
  resource_id: uuid('resource_id')
    .notNull()
    .references(() => learning_resources.id, { onDelete: 'cascade' }),
  saved_at: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.user_id, table.resource_id] }),
  index('saved_courses_user_id_idx').on(table.user_id),
])

// ─── Search vocabulary ────────────────────────────────────────────────────────

/**
 * Every word in the active catalogue's text (title, summary, skills,
 * institution), lowercase and unstemmed, with the number of active resources
 * containing it. Search uses it to correct typos: a query word that isn't
 * here matches nothing, so it's replaced by its closest frequent word
 * (src/search/vocabulary.ts).
 *
 * Derived data, rebuilt in full by refreshVocabulary(): at the end of the
 * embed job, or with `npm run search:vocabulary`. Empty until the first
 * refresh, and then typo correction is off.
 */
export const search_vocabulary = pgTable('search_vocabulary', {
  word: text('word').primaryKey(),
  doc_count: integer('doc_count').notNull(),
}, (table) => [
  // Two ways to find candidate corrections: similar trigrams (pg_trgm), or the
  // same first letter and a similar length (catches swapped letters, which
  // trigrams miss: "pyhton" vs "python").
  index('sv_word_trgm_idx').using('gin', table.word.op('gin_trgm_ops')),
  index('sv_first_letter_length_idx').on(sql`left(${table.word}, 1)`, sql`length(${table.word})`),
])
