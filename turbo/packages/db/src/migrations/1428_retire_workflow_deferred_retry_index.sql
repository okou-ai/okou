-- okou:non-transactional
-- Only the retired schedule-expiry retry lane ordered by this index.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_workflow_automations_deferred_retry";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
