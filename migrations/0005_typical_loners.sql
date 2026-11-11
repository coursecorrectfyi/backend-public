CREATE TABLE "chat_usage" (
	"identity" text NOT NULL,
	"identity_type" text NOT NULL,
	"query_date" date NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chat_usage_identity_query_date_pk" PRIMARY KEY("identity","query_date")
);
--> statement-breakpoint
CREATE INDEX "chat_usage_date_idx" ON "chat_usage" USING btree ("query_date");