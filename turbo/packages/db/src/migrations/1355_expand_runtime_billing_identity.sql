ALTER TABLE "model_routes" ALTER COLUMN "pricing_provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "usage_event" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "usage_pricing" ALTER COLUMN "provider" SET DATA TYPE text;