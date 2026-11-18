-- Embeddings as halfvec (16-bit floats): the HNSW index is half the size, and embeddings fit in the row instead of
-- TOAST. Rewrites the table and rebuilds its indexes under an exclusive lock: run it where that's acceptable (on the
-- VM between restore and switch). See docs/deployment-gcp.md, "The halfvec migration".
--
-- The old HNSW index goes first: its operator class (vector_cosine_ops) doesn't accept halfvec. It was created
-- without a name in 0000, so it has Postgres's default one. IF EXISTS: a restore may have skipped it.
DROP INDEX IF EXISTS "learning_resources_embedding_idx";--> statement-breakpoint
ALTER TABLE "learning_resources" ALTER COLUMN "embedding" SET DATA TYPE halfvec(768);--> statement-breakpoint
CREATE INDEX "lr_embedding_hnsw_idx" ON "learning_resources" USING hnsw ("embedding" halfvec_cosine_ops);
