-- Canonical capture already validates immutable owner/start/source values in
-- ensure_billing_run_attribution. Both thread-fill functions only change an
-- unknown grouping identity, and observation writers only set true. The
-- retained operator and R1 SQL writers follow those same predicates. This
-- redundant mutation guard is independent of the still-required capture and
-- observation triggers used by outgoing APIs.
DROP TRIGGER billing_run_attribution_immutable ON billing_run_attribution;
--> statement-breakpoint
DROP FUNCTION reject_billing_attribution_update();
