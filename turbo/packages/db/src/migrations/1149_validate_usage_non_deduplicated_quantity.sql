ALTER TABLE "usage_event_hourly_rollup" VALIDATE CONSTRAINT "chk_usage_event_hourly_non_deduplicated_quantity";
--> statement-breakpoint
ALTER TABLE "usage_event" VALIDATE CONSTRAINT "chk_usage_event_non_deduplicated_quantity";
