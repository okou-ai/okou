-- vm0:non-transactional
-- 1) Contract computer_use_command_audit_events.approval_outcome. #36984 stopped
-- naming it in audit INSERT and SELECT and is in production; the API rollback
-- floor excludes older writers. DROP COLUMN needs a brief ACCESS EXCLUSIVE lock,
-- so keep the normal short lock wait instead of queueing behind audit writes.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "computer_use_command_audit_events" DROP COLUMN "approval_outcome";
--> statement-breakpoint
-- 2) Turn off fastupdate so each projector INSERT updates the chat search GIN
-- index directly, then flush the pending list left by earlier inserts. SET
-- takes SHARE UPDATE EXCLUSIVE and the flush works page by page, so neither
-- blocks chat search reads or projector writes; either may wait behind
-- autovacuum or a cold cache.
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
