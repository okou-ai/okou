-- vm0:non-transactional
-- Chat search and MCP chat search filter by user_id, so they are served by
-- chat_event_search_messages_user_tsv_gin_idx. CONCURRENTLY does not block
-- chat search reads or projector writes, but it waits for older transactions
-- on the table, so a 1s lock timeout would only fail behind long searches.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_event_search_messages_tsv_idx";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
