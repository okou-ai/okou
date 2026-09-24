-- vm0:non-transactional
SET lock_timeout = '1s';
--> statement-breakpoint
-- Concurrent builds on existing streams may exceed the normal statement limit.
SET statement_timeout = '10min';
--> statement-breakpoint
-- Recover an invalid index left by an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_thread_event_sequences_org_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_thread_event_sequences_org_idx" ON "chat_thread_event_sequences" USING btree ("org_id");
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
