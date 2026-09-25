-- vm0:non-transactional
-- No query needs (user_id, org_id, agent_id, created_at) order since #36456.
-- Agent-scoped chat search is served by chat_event_search_messages_user_tsv_gin_idx.
-- CONCURRENTLY does not block chat search reads or projector writes, but it
-- waits for older transactions on the table, so a 1s lock timeout would only
-- fail behind long searches.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_event_search_messages_user_org_agent_id_created_idx";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
