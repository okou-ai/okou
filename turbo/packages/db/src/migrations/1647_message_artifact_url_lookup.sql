-- okou:non-transactional
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "run_uploaded_files_owner_url_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "run_uploaded_files_owner_url_idx" ON "run_uploaded_files" USING btree ("org_id","user_id",md5("url"),"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "run_uploaded_files"."url" IS NOT NULL AND "run_uploaded_files"."deleted_at" IS NULL;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
