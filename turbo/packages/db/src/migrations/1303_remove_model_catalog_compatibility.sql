ALTER TABLE "subscription_model_catalog" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "subscription_model_catalog" CASCADE;--> statement-breakpoint
DROP INDEX "idx_org_model_policies_one_default_per_org";--> statement-breakpoint
ALTER TABLE "org_model_policies" DROP COLUMN "is_default";--> statement-breakpoint
ALTER TABLE "run_model_catalog" DROP COLUMN "allow_new_org_policy";