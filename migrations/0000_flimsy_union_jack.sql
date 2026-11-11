-- Add manually since Drizzle doesn't support extensions yet
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "course_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"provider_review_id" text,
	"author_name" text,
	"rating" double precision,
	"review_date" date,
	"review_text" text,
	"helpful_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cr_resource_provider_review" UNIQUE("resource_id","provider_review_id")
);
--> statement-breakpoint
CREATE TABLE "learning_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_type" text,
	"legacy_mongo_id" text,
	"resource_type" text NOT NULL,
	"title" text NOT NULL,
	"ai_summary" text,
	"institution" text,
	"language" text,
	"level" text,
	"duration_hours" double precision,
	"rating" double precision,
	"num_ratings" integer,
	"is_free" boolean,
	"has_certificate" boolean,
	"skills" text[],
	"career_paths" text[],
	"ai_insights" jsonb,
	"ai_insights_updated_at" timestamp with time zone,
	"search_document" "tsvector",
	"embedding" vector(768),
	"source_url" text NOT NULL,
	"affiliate_url" text,
	"last_seen_at" bigint NOT NULL,
	"last_normalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lr_provider_external_id" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "learning_resources_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"source_url" text NOT NULL,
	"run_id" uuid,
	"html_gcs_key" text NOT NULL,
	"extracted_data" jsonb,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted_at" timestamp with time zone,
	CONSTRAINT "lrr_provider_external_id" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "resource_topics" (
	"resource_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"relevance_score" double precision DEFAULT 1 NOT NULL,
	CONSTRAINT "resource_topics_resource_id_topic_id_pk" PRIMARY KEY("resource_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"outcome" text NOT NULL,
	"error_type" text,
	"error_message" text,
	"html_snapshot_key" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"total_urls" integer,
	"success_count" integer,
	"failure_count" integer,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "saved_courses" (
	"user_id" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_courses_user_id_resource_id_pk" PRIMARY KEY("user_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"meta_description" text,
	"cross_provider_insights" jsonb,
	"insights_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_name_unique" UNIQUE("name"),
	CONSTRAINT "topics_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"firebase_uid" text PRIMARY KEY NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_reviews" ADD CONSTRAINT "course_reviews_resource_id_learning_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."learning_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_resources" ADD CONSTRAINT "learning_resources_raw_id_learning_resources_raw_id_fk" FOREIGN KEY ("raw_id") REFERENCES "public"."learning_resources_raw"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_resources_raw" ADD CONSTRAINT "learning_resources_raw_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_topics" ADD CONSTRAINT "resource_topics_resource_id_learning_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."learning_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_topics" ADD CONSTRAINT "resource_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_courses" ADD CONSTRAINT "saved_courses_resource_id_learning_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."learning_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_id_topics_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_reviews_resource_id_idx" ON "course_reviews" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "lr_search_document_idx" ON "learning_resources" USING gin ("search_document");--> statement-breakpoint
CREATE INDEX "lr_provider_idx" ON "learning_resources" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "lr_resource_type_idx" ON "learning_resources" USING btree ("resource_type");--> statement-breakpoint
CREATE INDEX "lr_level_idx" ON "learning_resources" USING btree ("level");--> statement-breakpoint
CREATE INDEX "lr_rating_idx" ON "learning_resources" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "lr_is_free_idx" ON "learning_resources" USING btree ("is_free");--> statement-breakpoint
CREATE INDEX "lr_has_certificate_idx" ON "learning_resources" USING btree ("has_certificate");--> statement-breakpoint
CREATE INDEX "lr_last_seen_at_idx" ON "learning_resources" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "resource_topics_topic_id_idx" ON "resource_topics" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "run_results_run_id_outcome_idx" ON "run_results" USING btree ("run_id","outcome");--> statement-breakpoint
CREATE INDEX "saved_courses_user_id_idx" ON "saved_courses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topics_slug_idx" ON "topics" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "topics_parent_id_idx" ON "topics" USING btree ("parent_id");

-- Added manually since Drizzle doesn't support vector indexes yet
CREATE INDEX ON learning_resources USING hnsw (embedding vector_cosine_ops);

-- Added manually since Drizzle doesn't support trigger functions yet
CREATE OR REPLACE FUNCTION update_search_document() RETURNS trigger AS $$
BEGIN
  NEW.search_document :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.ai_summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.skills, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.institution, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.provider, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lr_search_document_trigger
  BEFORE INSERT OR UPDATE OF title, ai_summary, skills, institution, provider
  ON learning_resources
  FOR EACH ROW EXECUTE FUNCTION update_search_document();