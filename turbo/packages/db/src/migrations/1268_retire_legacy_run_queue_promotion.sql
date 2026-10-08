-- vm0:non-transactional
-- 1) #37034 stopped creating queued runs and is the rollback floor, and this
-- release no longer promotes them. Remove any active row a queued run still
-- holds so only pending and running runs occupy active_agent_runs. The
-- production gate expects none. Both statements are idempotent, so a rerun
-- after a later failure is safe: the runner journals a non-transactional
-- migration only after its last statement.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
DELETE FROM "active_agent_runs" AS "active"
USING "agent_runs" AS "run"
WHERE "run"."id" = "active"."run_id"
  AND "run"."status" = 'queued';
--> statement-breakpoint
-- 2) Pending input reads are per-thread: they take the thread's run-less input
-- rows through the thread indexes and then drop revoked rows through the
-- revokes_event_id index, so chat_events_pending_queue_idx no longer serves a
-- query. Dropping it removes index maintenance from every chat input insert.
-- CONCURRENTLY does not block chat_events writers, but it waits for older
-- transactions on the table, so a 1s lock timeout would only fail behind long
-- readers.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_pending_queue_idx";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
