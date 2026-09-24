-- vm0:non-transactional
-- Build the delivery FK's event/thread identity without blocking Chat writers.
-- The FK is added only by the following transactional migration, so a retry
-- after an interrupted build or journal write can safely recreate this index.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_id_thread_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_events_id_thread_unique"
  ON "chat_events" USING btree ("id", "chat_thread_id");
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
