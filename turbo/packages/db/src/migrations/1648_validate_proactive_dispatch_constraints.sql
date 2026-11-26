-- The expansion committed in 1647. Validate on a weaker lock so production reads and writes can continue.
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
ALTER TABLE "billing_run_attribution"
  VALIDATE CONSTRAINT "billing_run_attribution_source_check",
  VALIDATE CONSTRAINT "billing_run_attribution_credit_policy_check";
--> statement-breakpoint
ALTER TABLE "chat_events" VALIDATE CONSTRAINT "chat_events_context_type_check";
