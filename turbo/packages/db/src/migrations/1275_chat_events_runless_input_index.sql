-- vm0:non-transactional
-- Pending-input reads filter one thread's run-less input rows, but the only
-- thread-scoped indexes cover every event type, so each read visits the whole
-- retained thread history. This partial index covers only run-less input rows.
-- CONCURRENTLY does not block chat event writes but waits for older
-- transactions on chat_events.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
-- Recover an invalid index left by an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_thread_runless_input_seq_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_events_thread_runless_input_seq_idx" ON "chat_events" USING btree ("chat_thread_id","seq_id") WHERE "chat_events"."run_id" IS NULL AND "chat_events"."event_type" IN ('input.prompt', 'input.automation', 'input.budget');
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
