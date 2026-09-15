-- vm0:non-transactional
-- Bound FK cleanup probes without blocking active checkpoint writers.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_sessions_agent";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_agent_sessions_agent" ON "agent_sessions" USING btree ("agent_id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_sessions_conversation";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_agent_sessions_conversation" ON "agent_sessions" USING btree ("conversation_id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_checkpoints_conversation";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_checkpoints_conversation" ON "checkpoints" USING btree ("conversation_id");
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
