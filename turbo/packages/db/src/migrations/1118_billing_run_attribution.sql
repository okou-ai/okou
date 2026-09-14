CREATE TABLE "billing_attribution_backfill" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"run_from" uuid,
	"run_through" uuid,
	"phase" text DEFAULT 'runs' NOT NULL,
	"cursor" uuid,
	"scanned" bigint DEFAULT 0 NOT NULL,
	"populated" bigint DEFAULT 0 NOT NULL,
	"missing_source" bigint DEFAULT 0 NOT NULL,
	"conflicts" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_attribution_backfill_phase_check" CHECK ("billing_attribution_backfill"."phase" IN ('runs', 'jobs', 'raw', 'hourly', 'done'))
);
--> statement-breakpoint
CREATE TABLE "billing_run_attribution" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_started_at" timestamp NOT NULL,
	"source" text NOT NULL,
	"usage_observed" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_run_attribution_source_check" CHECK ("billing_run_attribution"."source" IN ('chat', 'automation', 'slack', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent', 'other'))
);
--> statement-breakpoint
ALTER TABLE "built_in_generation_jobs" ADD COLUMN "billing_run_id" uuid;--> statement-breakpoint
ALTER TABLE "built_in_generation_jobs" ADD COLUMN "billing_context" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD COLUMN "billing_run_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD COLUMN "billing_anchor_at" timestamp;--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD COLUMN "billing_context" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "billing_run_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "billing_anchor_at" timestamp;--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "billing_context" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_billing_run_attribution_owner" ON "billing_run_attribution" USING btree ("org_id","user_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_rollup_billing_run" ON "usage_event_hourly_rollup" USING btree ("billing_run_id");--> statement-breakpoint
CREATE INDEX "idx_usage_event_billing_run" ON "usage_event" USING btree ("billing_run_id");--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD CONSTRAINT "usage_event_hourly_rollup_billing_context_check" CHECK ((
        ("usage_event_hourly_rollup"."billing_context" = 'run' AND "usage_event_hourly_rollup"."billing_run_id" IS NOT NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NOT NULL)
        OR ("usage_event_hourly_rollup"."billing_context" = 'runless' AND "usage_event_hourly_rollup"."billing_run_id" IS NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NOT NULL)
        OR ("usage_event_hourly_rollup"."billing_context" = 'missing_run' AND "usage_event_hourly_rollup"."billing_run_id" IS NOT NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NULL)
        OR ("usage_event_hourly_rollup"."billing_context" = 'legacy_unknown' AND "usage_event_hourly_rollup"."billing_run_id" IS NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_billing_context_check" CHECK ((
        ("usage_event"."billing_context" = 'run' AND "usage_event"."billing_run_id" IS NOT NULL AND "usage_event"."billing_anchor_at" IS NOT NULL)
        OR ("usage_event"."billing_context" = 'runless' AND "usage_event"."billing_run_id" IS NULL AND "usage_event"."billing_anchor_at" IS NOT NULL)
        OR ("usage_event"."billing_context" = 'missing_run' AND "usage_event"."billing_run_id" IS NOT NULL AND "usage_event"."billing_anchor_at" IS NULL)
        OR ("usage_event"."billing_context" = 'legacy_unknown' AND "usage_event"."billing_run_id" IS NULL AND "usage_event"."billing_anchor_at" IS NULL)
      ));