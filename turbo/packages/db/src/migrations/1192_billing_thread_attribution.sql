ALTER TABLE "billing_run_attribution" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD COLUMN "thread_context" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD CONSTRAINT "billing_run_attribution_thread_context_check" CHECK ((
        ("billing_run_attribution"."thread_context" = 'thread' AND "billing_run_attribution"."thread_id" IS NOT NULL)
        OR ("billing_run_attribution"."thread_context" IN ('threadless', 'unknown') AND "billing_run_attribution"."thread_id" IS NULL)
      ));