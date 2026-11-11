ALTER TABLE "learning_resources" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "lr_is_active_idx" ON "learning_resources" USING btree ("is_active");