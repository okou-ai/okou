-- vm0:non-transactional
-- Build the btree_gin user + keyword index without blocking chat search reads
-- or projector writes. CONCURRENTLY waits for older transactions database-wide,
-- and those waits do not block ordinary reads or writes, so a 1s lock timeout
-- would only fail the build behind existing long-running searches.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;
--> statement-breakpoint
-- A failed concurrent build leaves an INVALID index that still slows writes.
DROP INDEX CONCURRENTLY IF EXISTS "chat_event_search_messages_user_tsv_gin_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_event_search_messages_user_tsv_gin_idx" ON "chat_event_search_messages" USING gin ("user_id","tsv");
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
