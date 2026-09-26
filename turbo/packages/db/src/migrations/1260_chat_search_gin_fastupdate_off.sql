-- vm0:non-transactional
-- Turn off fastupdate so each projector INSERT updates the chat search GIN
-- index directly, then flush the pending list left by earlier inserts. With no
-- pending list the API no longer drains it. Neither statement blocks chat
-- search reads or projector writes: SET takes SHARE UPDATE EXCLUSIVE and the
-- flush works page by page, but either may wait behind autovacuum or a cold
-- cache, so this session raises its own timeouts and resets them.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
ALTER INDEX "chat_event_search_messages_user_tsv_gin_idx" SET (fastupdate = false);
--> statement-breakpoint
SELECT gin_clean_pending_list('chat_event_search_messages_user_tsv_gin_idx'::regclass);
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
