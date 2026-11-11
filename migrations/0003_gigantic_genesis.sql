CREATE TABLE "onet_job_zones" (
	"soc_code" text PRIMARY KEY NOT NULL,
	"job_zone" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onet_occupations" (
	"soc_code" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "onet_skills" (
	"soc_code" text NOT NULL,
	"element_name" text NOT NULL,
	"scale_id" text NOT NULL,
	"data_value" double precision NOT NULL,
	CONSTRAINT "onet_skills_soc_code_element_name_scale_id_pk" PRIMARY KEY("soc_code","element_name","scale_id")
);
--> statement-breakpoint
CREATE TABLE "onet_wages" (
	"soc_code" text PRIMARY KEY NOT NULL,
	"median_annual" integer,
	"pct_10_annual" integer,
	"pct_90_annual" integer,
	"growth_rate" double precision,
	"growth_category" text
);
--> statement-breakpoint
ALTER TABLE "onet_job_zones" ADD CONSTRAINT "onet_job_zones_soc_code_onet_occupations_soc_code_fk" FOREIGN KEY ("soc_code") REFERENCES "public"."onet_occupations"("soc_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onet_skills" ADD CONSTRAINT "onet_skills_soc_code_onet_occupations_soc_code_fk" FOREIGN KEY ("soc_code") REFERENCES "public"."onet_occupations"("soc_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onet_wages" ADD CONSTRAINT "onet_wages_soc_code_onet_occupations_soc_code_fk" FOREIGN KEY ("soc_code") REFERENCES "public"."onet_occupations"("soc_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onet_skills_soc_code_idx" ON "onet_skills" USING btree ("soc_code");--> statement-breakpoint
CREATE INDEX "onet_skills_element_name_idx" ON "onet_skills" USING btree ("element_name");