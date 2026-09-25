-- vm0:non-transactional
-- Both indexes only served as user_id / (user_id, agent_id) prefixes, which
-- idx_chat_threads_user_last_message_id and
-- idx_chat_threads_user_agent_last_message already cover. Keeping
-- last_read_at and updated_at indexed made every read-cursor and metadata
-- update non-HOT. CONCURRENTLY does not block chat_threads writers, but it
-- waits for older transactions on the table, so a 1s lock timeout would only
-- fail behind long readers.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_threads_user_agent_updated";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_threads_user_last_read";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
