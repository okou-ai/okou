CREATE TABLE "data_search_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"billing_run_id" uuid,
	"capability" text NOT NULL,
	"request" jsonb NOT NULL,
	"plan" jsonb NOT NULL,
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "data_search_jobs_status_check" CHECK ("data_search_jobs"."status" IN ('pending','running','completed','failed','cancelled','unknown')),
	CONSTRAINT "data_search_jobs_amounts_check" CHECK ("data_search_jobs"."estimated_cost_usd_micros" >= 0 AND "data_search_jobs"."actual_cost_usd_micros" >= 0 AND "data_search_jobs"."unit_price" >= 0 AND "data_search_jobs"."unit_size" > 0 AND "data_search_jobs"."max_credits" >= 0 AND "data_search_jobs"."reserved_credits" >= 0 AND "data_search_jobs"."reserved_credits" <= "data_search_jobs"."max_credits" AND "data_search_jobs"."credits_charged" >= 0 AND "data_search_jobs"."credits_charged" <= "data_search_jobs"."max_credits")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_data_search_jobs_request" ON "data_search_jobs" USING btree ("org_id","user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_data_search_jobs_usage" ON "data_search_jobs" USING btree ("usage_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_data_search_jobs_upstream" ON "data_search_jobs" USING btree ("provider_name","upstream_run_id");--> statement-breakpoint
CREATE INDEX "idx_data_search_jobs_owner" ON "data_search_jobs" USING btree ("org_id","user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_data_search_jobs_reserved" ON "data_search_jobs" USING btree ("org_id") WHERE "data_search_jobs"."credits_charged" IS NULL;
