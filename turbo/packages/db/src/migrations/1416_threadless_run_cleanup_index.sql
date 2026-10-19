-- okou:non-transactional
-- Bound threadless candidate discovery without blocking active Run writes.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
-- A retry must recover an invalid index left by an interrupted online build.
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_threadless_created_id";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_agent_runs_threadless_created_id" ON "agent_runs" USING btree ("created_at","id") WHERE "agent_runs"."trigger_source" IS NOT NULL AND "agent_runs"."chat_thread_id" IS NULL;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
