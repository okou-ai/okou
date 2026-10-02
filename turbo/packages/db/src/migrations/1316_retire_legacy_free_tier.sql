-- Production writers no longer emit the retired tier. Reject new writes while
-- normalizing residual data in other environments in this same transaction.
ALTER TABLE "org_metadata" ADD CONSTRAINT "chk_org_metadata_tier_not_free"
CHECK ("tier" <> 'free') NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_metadata" ADD CONSTRAINT "chk_org_metadata_pending_target_not_free"
CHECK ("pending_subscription_target_tier" IS NULL OR "pending_subscription_target_tier" <> 'free') NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" ADD CONSTRAINT "chk_org_plan_entitlements_plan_key_not_free"
CHECK ("plan_key" <> 'free') NOT VALID;
--> statement-breakpoint
-- A legacy entitlement may legitimately predate metadata. Do not create a
-- wallet for it. Conflicting plans or subscription-linked rows need review,
-- not an automatic downgrade or fabricated companion entitlement.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "org_metadata" m
    FULL JOIN "org_plan_entitlements" e ON e."org_id" = m."org_id"
    WHERE (m."tier" = 'free' OR e."plan_key" = 'free')
      AND (
        e."org_id" IS NULL
        OR e."plan_key" IS DISTINCT FROM 'free'
        OR (m."org_id" IS NOT NULL AND m."tier" IS DISTINCT FROM 'free')
        OR m."stripe_subscription_id" IS NOT NULL
        OR e."stripe_subscription_id" IS NOT NULL
        OR m."subscription_status" IN ('active', 'trialing', 'past_due', 'unpaid')
        OR m."pending_subscription_schedule_id" IS NOT NULL
        OR m."pending_subscription_change_at" IS NOT NULL
        OR (m."pending_subscription_target_tier" IS NOT NULL
            AND m."pending_subscription_target_tier" <> 'free')
      )
  ) THEN
    RAISE EXCEPTION 'Legacy Free has mismatched/missing entitlements or subscription state; inspect before migrating';
  END IF;
END
$$;
--> statement-breakpoint
-- Preserve balances, subscription history, onboarding and model configuration.
UPDATE "org_metadata"
SET
  "tier" = CASE WHEN "tier" = 'free' THEN 'limited-free-1' ELSE "tier" END,
  "pending_subscription_target_tier" = CASE
    WHEN "pending_subscription_target_tier" = 'free' THEN 'limited-free-1'
    ELSE "pending_subscription_target_tier"
  END,
  "updated_at" = now()
WHERE "tier" = 'free' OR "pending_subscription_target_tier" = 'free';
--> statement-breakpoint
-- Replace only the plan capabilities. Preserve suspension, source, periods,
-- expiry and billing provenance; do not grant credits or provision an Agent.
UPDATE "org_plan_entitlements"
SET
  "plan_key" = 'limited-free-1',
  "plan_rank" = 0,
  "base_concurrency_limit" = 2,
  "can_buy_concurrency" = false,
  "can_buy_credits" = false,
  "show_usage_pack" = false,
  "auto_recharge_allowed" = false,
  "support_byok" = true,
  "restricted_built_in_models" = true,
  "workflow_webhook_trigger_allowed" = false,
  "audio_lifetime_limit" = 10,
  "audio_daily_rate_limit" = 10,
  "audio_daily_duration_seconds" = 600,
  "metadata_hash" = NULL,
  "updated_at" = now()
WHERE "plan_key" = 'free';
--> statement-breakpoint
ALTER TABLE "org_metadata" VALIDATE CONSTRAINT "chk_org_metadata_tier_not_free";
--> statement-breakpoint
ALTER TABLE "org_metadata" VALIDATE CONSTRAINT "chk_org_metadata_pending_target_not_free";
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" VALIDATE CONSTRAINT "chk_org_plan_entitlements_plan_key_not_free";
