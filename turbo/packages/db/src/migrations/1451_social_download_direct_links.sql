DROP INDEX "uq_socialkit_download_jobs_user_active";--> statement-breakpoint
UPDATE "socialkit_download_jobs"
SET "status" = CASE "status"
  WHEN 'materializing' THEN 'processing'
  WHEN 'artifact_failed' THEN 'link_failed'
END,
"claim_expires_at" = NULL
WHERE "status" IN ('materializing', 'artifact_failed');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_socialkit_download_jobs_user_active" ON "socialkit_download_jobs" USING btree ("user_id") WHERE status IN ('submitting', 'processing', 'link_failed');--> statement-breakpoint
ALTER TABLE "socialkit_download_jobs" DROP COLUMN "artifact";