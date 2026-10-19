ALTER TABLE "billing_run_attribution" ADD COLUMN "run_terminal_status" text;--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD COLUMN "run_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD COLUMN "run_lifecycle_context" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD CONSTRAINT "billing_run_attribution_lifecycle_check" CHECK ((
          ("billing_run_attribution"."run_lifecycle_context" IN ('unknown', 'legacy_unavailable')
            AND "billing_run_attribution"."run_terminal_status" IS NULL AND "billing_run_attribution"."run_completed_at" IS NULL)
          OR ("billing_run_attribution"."run_lifecycle_context" = 'captured' AND (
            ("billing_run_attribution"."run_terminal_status" IS NULL AND "billing_run_attribution"."run_completed_at" IS NULL)
            OR ("billing_run_attribution"."run_terminal_status" IS NOT NULL
              AND "billing_run_attribution"."run_terminal_status" IN ('completed', 'failed', 'cancelled', 'timeout'))
          ))
        ));