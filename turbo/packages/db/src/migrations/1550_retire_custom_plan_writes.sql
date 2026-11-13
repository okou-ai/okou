ALTER TABLE "org_metadata" ADD CONSTRAINT "chk_org_metadata_tier_not_custom" CHECK ("org_metadata"."tier" <> 'custom') NOT VALID;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD CONSTRAINT "chk_org_metadata_pending_target_not_custom" CHECK ("org_metadata"."pending_subscription_target_tier" IS NULL OR "org_metadata"."pending_subscription_target_tier" <> 'custom') NOT VALID;--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" ADD CONSTRAINT "chk_org_plan_entitlements_plan_key_not_custom" CHECK ("org_plan_entitlements"."plan_key" <> 'custom') NOT VALID;--> statement-breakpoint
ALTER TABLE "org_metadata" VALIDATE CONSTRAINT "chk_org_metadata_tier_not_custom";--> statement-breakpoint
ALTER TABLE "org_metadata" VALIDATE CONSTRAINT "chk_org_metadata_pending_target_not_custom";--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" VALIDATE CONSTRAINT "chk_org_plan_entitlements_plan_key_not_custom";
