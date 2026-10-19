-- okou:non-transactional
-- Keep catalog ownership preservation a bounded write-time projection lookup.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
-- Recover an invalid index left by an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "artifacts_projection_file_org_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "artifacts_projection_file_org_idx" ON "artifacts" USING btree ("projection_file_id","org_id") WHERE "artifacts"."projection_file_id" IS NOT NULL;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
