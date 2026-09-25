-- Separate transaction: validation retains the newly expanded checks without
-- holding the ACCESS EXCLUSIVE locks used to replace the previous definitions.
ALTER TABLE "billing_run_attribution"
  VALIDATE CONSTRAINT "billing_run_attribution_source_check";
--> statement-breakpoint
ALTER TABLE "chat_events"
  VALIDATE CONSTRAINT "chat_events_context_type_check";
