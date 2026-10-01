-- Current Run/job/raw/hourly producers explicitly publish billing identity and
-- monotone observation in their owning transaction. No rolling-writer mutex or
-- new trigger replaces these application hooks. Their functions are invoked by no
-- trigger, migration-applied code, or API/App version, so they retire here too.
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
--> statement-breakpoint
DROP FUNCTION capture_billing_run_attribution();
--> statement-breakpoint
DROP FUNCTION capture_generation_billing_identity();
--> statement-breakpoint
DROP FUNCTION capture_usage_billing_attribution();
--> statement-breakpoint
DROP FUNCTION mark_billing_usage_observed();
--> statement-breakpoint
DROP FUNCTION ensure_billing_run_attribution(uuid, text, text, timestamp, text);
--> statement-breakpoint
DROP FUNCTION ensure_billing_run_thread(uuid, uuid);
--> statement-breakpoint
DROP FUNCTION billing_usage_source(text);
