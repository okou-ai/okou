-- Separate transaction: validation uses SHARE UPDATE EXCLUSIVE, not the
-- ACCESS EXCLUSIVE lock held by the previous constraint replacement.
ALTER TABLE usage_event VALIDATE CONSTRAINT usage_event_billing_context_check;
--> statement-breakpoint
ALTER TABLE usage_event_hourly_rollup VALIDATE CONSTRAINT usage_event_hourly_rollup_billing_context_check;
