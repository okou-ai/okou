-- Validate in a separate transaction so the earlier ACCESS EXCLUSIVE locks
-- are released before PostgreSQL scans existing rows.
ALTER TABLE "billing_run_attribution" VALIDATE CONSTRAINT "billing_run_attribution_source_check";
--> statement-breakpoint
ALTER TABLE "chat_events" VALIDATE CONSTRAINT "chat_events_context_type_check";
