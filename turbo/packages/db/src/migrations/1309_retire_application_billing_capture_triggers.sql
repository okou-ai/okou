-- Current Run/job/raw/hourly producers explicitly publish billing identity and
-- monotone observation in their owning transaction. No rolling-writer mutex or
-- new trigger replaces these application hooks. Historical function definitions
-- remain only for the separate migration-layer retirement release.
DROP TRIGGER "capture_billing_run_attribution" ON "agent_runs";
--> statement-breakpoint
DROP TRIGGER "capture_generation_billing_identity" ON "built_in_generation_jobs";
--> statement-breakpoint
DROP TRIGGER "capture_usage_billing_attribution" ON "usage_event";
--> statement-breakpoint
DROP TRIGGER "mark_raw_billing_usage_observed" ON "usage_event";
--> statement-breakpoint
DROP TRIGGER "capture_hourly_billing_attribution" ON "usage_event_hourly_rollup";
--> statement-breakpoint
DROP TRIGGER "mark_hourly_billing_usage_observed" ON "usage_event_hourly_rollup";
