ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_price_tier";--> statement-breakpoint
ALTER TABLE "run_model_catalog" DROP CONSTRAINT "chk_run_model_catalog_default_active";--> statement-breakpoint
DROP INDEX "idx_model_providers_one_default_per_user";--> statement-breakpoint
DROP INDEX "idx_run_model_catalog_one_system_default";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "auth_method";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "is_default";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "selected_model";--> statement-breakpoint
ALTER TABLE "model_routes" DROP COLUMN "price_tier";--> statement-breakpoint
ALTER TABLE "run_model_catalog" DROP COLUMN "is_system_default";