ALTER TABLE "usage_event_hourly_rollup" ADD COLUMN "non_deduplicated_quantity" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "non_deduplicated_quantity" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD CONSTRAINT "chk_usage_event_hourly_non_deduplicated_quantity" CHECK ("usage_event_hourly_rollup"."non_deduplicated_quantity" >= 0 AND "usage_event_hourly_rollup"."non_deduplicated_quantity" <= "usage_event_hourly_rollup"."quantity") NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "chk_usage_event_non_deduplicated_quantity" CHECK ("usage_event"."non_deduplicated_quantity" >= 0 AND "usage_event"."non_deduplicated_quantity" <= "usage_event"."quantity") NOT VALID;
