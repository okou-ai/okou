CREATE TABLE "social_data_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"billing_run_id" uuid,
	"platform" varchar(16) NOT NULL,
	"operation" varchar(16) NOT NULL,
	"request" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"provider_name" text NOT NULL,
	"provider_endpoint" text NOT NULL,
	"upstream_run_id" text,
	"result" jsonb,
	"error" jsonb,
	"estimated_cost_usd_micros" bigint NOT NULL,
	"actual_cost_usd_micros" bigint,
	"unit_price" bigint NOT NULL,
	"unit_size" bigint NOT NULL,
	"max_credits" bigint NOT NULL,
	"reserved_credits" bigint NOT NULL,
	"credits_charged" bigint,
	"usage_idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp,
	"stop_requested_at" timestamp,
	"stop_submitted_at" timestamp,
	"claim_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "social_data_jobs_status_check" CHECK ("social_data_jobs"."status" IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
	CONSTRAINT "social_data_jobs_amounts_check" CHECK ("social_data_jobs"."estimated_cost_usd_micros" >= 0
          AND "social_data_jobs"."actual_cost_usd_micros" >= 0
          AND "social_data_jobs"."unit_price" >= 0 AND "social_data_jobs"."unit_size" > 0
          AND "social_data_jobs"."max_credits" >= 0
          AND "social_data_jobs"."reserved_credits" >= 0
          AND "social_data_jobs"."reserved_credits" <= "social_data_jobs"."max_credits"
          AND "social_data_jobs"."credits_charged" >= 0
          AND "social_data_jobs"."credits_charged" <= "social_data_jobs"."max_credits")
);
--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "pricing_unit_price" bigint;--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "pricing_unit_size" bigint;--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "pricing_credits_limit" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_social_data_jobs_request" ON "social_data_jobs" USING btree ("org_id","user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_social_data_jobs_usage" ON "social_data_jobs" USING btree ("usage_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_social_data_jobs_upstream" ON "social_data_jobs" USING btree ("upstream_run_id");--> statement-breakpoint
CREATE INDEX "idx_social_data_jobs_owner_id" ON "social_data_jobs" USING btree ("org_id","user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_social_data_jobs_reserved" ON "social_data_jobs" USING btree ("org_id") WHERE "social_data_jobs"."reserved_credits" > 0;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_pricing_snapshot_check" CHECK ((
          ("usage_event"."pricing_unit_price" IS NULL AND "usage_event"."pricing_unit_size" IS NULL AND "usage_event"."pricing_credits_limit" IS NULL)
          OR ("usage_event"."pricing_unit_price" IS NOT NULL AND "usage_event"."pricing_unit_size" IS NOT NULL AND "usage_event"."pricing_credits_limit" IS NOT NULL
            AND "usage_event"."pricing_unit_price" >= 0 AND "usage_event"."pricing_unit_size" > 0 AND "usage_event"."pricing_credits_limit" >= 0)
        ));