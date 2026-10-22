CREATE TABLE "commerce_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid,
	"usage_idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"operation" text NOT NULL,
	"marketplace" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request" jsonb NOT NULL,
	"provider_task_id" text,
	"provider_cost_usd" double precision,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_jobs_usage_idempotency_key_unique" UNIQUE("usage_idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "idx_commerce_jobs_status_created_at" ON "commerce_jobs" USING btree ("status","created_at");