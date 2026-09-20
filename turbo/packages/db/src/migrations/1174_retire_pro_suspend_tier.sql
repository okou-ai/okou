-- Keep the previous App/API deployment readable while preventing any new
-- pro-suspend value from being committed during this transactional rewrite.
ALTER TABLE "org_metadata"
ADD CONSTRAINT "chk_org_metadata_tier_not_pro_suspend"
CHECK ("tier" <> 'pro-suspend') NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_metadata"
ADD CONSTRAINT "chk_org_metadata_pending_target_not_pro_suspend"
CHECK (
  "pending_subscription_target_tier" IS NULL
  OR "pending_subscription_target_tier" <> 'pro-suspend'
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements"
ADD CONSTRAINT "chk_org_plan_entitlements_plan_key_not_pro_suspend"
CHECK ("plan_key" <> 'pro-suspend') NOT VALID;
--> statement-breakpoint
-- The cancellation target was already changed to limited-free-1. Normalize
-- historical plan state and any old scheduled target without touching credits,
-- subscription history, attribution, or onboarding state.
UPDATE "org_metadata"
SET
  "tier" = CASE
    WHEN "tier" = 'pro-suspend' THEN 'limited-free-1'
    ELSE "tier"
  END,
  "pending_subscription_target_tier" = CASE
    WHEN "pending_subscription_target_tier" = 'pro-suspend'
      THEN 'limited-free-1'
    ELSE "pending_subscription_target_tier"
  END,
  "updated_at" = now()
WHERE "tier" = 'pro-suspend'
   OR "pending_subscription_target_tier" = 'pro-suspend';
--> statement-breakpoint
-- Replace the complete capability snapshot rather than only renaming plan_key.
-- This makes every retired plan byte-for-byte equivalent to a newly written
-- limited-free-1 entitlement while preserving source and billing provenance.
UPDATE "org_plan_entitlements"
SET
  "plan_key" = 'limited-free-1',
  "plan_rank" = 0,
  "status" = 'active',
  "base_concurrency_limit" = 1,
  "can_buy_concurrency" = false,
  "can_buy_credits" = false,
  "show_usage_pack" = false,
  "auto_recharge_allowed" = false,
  "support_byok" = false,
  "restricted_built_in_models" = true,
  "video_generation_allowed" = false,
  "workflow_webhook_trigger_allowed" = false,
  "audio_lifetime_limit" = 10,
  "audio_daily_rate_limit" = 10,
  "audio_daily_duration_seconds" = 600,
  "updated_at" = now()
WHERE "plan_key" = 'pro-suspend';
--> statement-breakpoint
ALTER TABLE "org_metadata"
VALIDATE CONSTRAINT "chk_org_metadata_tier_not_pro_suspend";
--> statement-breakpoint
ALTER TABLE "org_metadata"
VALIDATE CONSTRAINT "chk_org_metadata_pending_target_not_pro_suspend";
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements"
VALIDATE CONSTRAINT "chk_org_plan_entitlements_plan_key_not_pro_suspend";
