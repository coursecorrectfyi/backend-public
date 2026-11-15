CREATE TABLE "chat_usage_daily" (
	"query_date" date NOT NULL,
	"identity_type" text NOT NULL,
	"identities" integer NOT NULL,
	"questions" integer NOT NULL,
	CONSTRAINT "chat_usage_daily_query_date_identity_type_pk" PRIMARY KEY("query_date","identity_type")
);
