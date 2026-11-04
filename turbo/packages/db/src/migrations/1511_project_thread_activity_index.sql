-- okou:non-transactional
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5min';
--> statement-breakpoint
-- A failed concurrent build can leave an invalid index. Full-file retries rebuild it.
DROP INDEX CONCURRENTLY IF EXISTS "chat_threads_user_project_activity_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_threads_user_project_activity_idx" ON "chat_threads" USING btree ("user_id","project_id","last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "chat_threads"."project_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chat_threads_project_owner_fk";
