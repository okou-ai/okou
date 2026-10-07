ALTER TABLE "run_model_catalog" DROP CONSTRAINT "chk_run_model_catalog_pi_route_class";--> statement-breakpoint
DROP INDEX "idx_model_provider_auth_sessions_sandbox";--> statement-breakpoint
ALTER TABLE "model_provider_auth_sessions" DROP COLUMN "sandbox_id";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "token_expires_at";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "needs_reconnect";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "last_refresh_error_code";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "workspace_name";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "plan_type";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "subscription_reset_period";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "subscription_next_reset_at";--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "chk_run_model_catalog_pi_route_class" CHECK ("run_model_catalog"."pi_route_class" IS NULL OR "run_model_catalog"."pi_route_class" = 'gpt-codex');