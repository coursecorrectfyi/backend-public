-- Typo correction for search (src/search/vocabulary.ts): a vocabulary of catalogue words, searched by trigram
-- similarity (pg_trgm) and edit distance (fuzzystrmatch). Both extensions ship with Postgres (contrib) and are
-- "trusted": a user with CREATE privilege on the database can create them, no superuser needed.
-- New, empty table: safe to apply while the previous release is running. Fill it afterwards with
-- `npm run search:vocabulary` (docs/deployment-gcp.md, "The search vocabulary").
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;--> statement-breakpoint
CREATE TABLE "search_vocabulary" (
	"word" text PRIMARY KEY NOT NULL,
	"doc_count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sv_word_trgm_idx" ON "search_vocabulary" USING gin ("word" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "sv_first_letter_length_idx" ON "search_vocabulary" USING btree (left("word", 1),length("word"));