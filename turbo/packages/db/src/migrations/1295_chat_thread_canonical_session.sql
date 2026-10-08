-- vm0:non-transactional
-- A chat thread owns at most one canonical agent session. CONCURRENTLY does not
-- block chat thread writes but waits for older transactions on chat_threads.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
-- Recover an invalid index left by an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_threads_agent_session_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_threads_agent_session_unique" ON "chat_threads" USING btree ("agent_session_id");
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
