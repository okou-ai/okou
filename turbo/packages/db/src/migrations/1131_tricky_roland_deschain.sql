ALTER TABLE "shared_threads" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "shared_threads" ADD COLUMN "has_artifact_snapshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "shared_threads_org_idx" ON "shared_threads" USING btree ("org_id");