-- Drop 9 retired artifact/sharing tables, atomically rename
-- artifact_user_shares -> artifact_shares (preserving live rows and aligning
-- constraint/index names), and drop 3 redundant columns on artifacts.
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
-- 1. Drop 4 child tables referencing run_uploaded_files first.
DROP TABLE IF EXISTS "public"."artifact_catalog_pending_files" RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."artifact_file_shares" RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."canonical_asset_deliveries" RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."video_artifacts" RESTRICT;
--> statement-breakpoint
-- 2. Drop 5 parent / independent retired tables (including legacy artifact_shares).
DROP TABLE IF EXISTS "public"."run_uploaded_files" RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."hosted_site_visibility" RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."hosted_site_shares" RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."image_artifact_edit_snapshots" RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."artifact_shares" RESTRICT;
--> statement-breakpoint
-- 3. Atomically promote artifact_user_shares -> artifact_shares with canonical names.
ALTER TABLE "public"."artifact_user_shares" RENAME TO "artifact_shares";
--> statement-breakpoint
ALTER TABLE "public"."artifact_shares" RENAME CONSTRAINT "artifact_user_shares_pk" TO "artifact_shares_pk";
--> statement-breakpoint
ALTER TABLE "public"."artifact_shares" RENAME CONSTRAINT "artifact_user_shares_artifact_id_artifacts_id_fk" TO "artifact_shares_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."artifact_user_shares_artifact_idx" RENAME TO "artifact_shares_artifact_idx";
--> statement-breakpoint
-- 4. Drop 3 redundant columns and associated partial index on artifacts.
DROP INDEX IF EXISTS "public"."artifacts_projection_file_org_idx";
--> statement-breakpoint
ALTER TABLE "public"."artifacts"
  DROP COLUMN IF EXISTS "projection_file_id",
  DROP COLUMN IF EXISTS "projection_created_at",
  DROP COLUMN IF EXISTS "video_source_url";
