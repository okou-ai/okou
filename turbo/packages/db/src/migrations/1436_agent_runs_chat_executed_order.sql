-- okou:non-transactional
-- Bound predecessor discovery without blocking active Run writes.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
-- Recover an invalid index left by an interrupted online build on retry.
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_chat_executed_order";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_agent_runs_chat_executed_order" ON "agent_runs" USING btree ("chat_thread_id","started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "agent_runs"."chat_thread_id" IS NOT NULL AND "agent_runs"."started_at" IS NOT NULL;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
