ALTER TABLE "built_in_model_candidate_cooldown" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "built_in_model_candidate_cooldown" CASCADE;--> statement-breakpoint
ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_service_tiers";--> statement-breakpoint
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
ALTER TABLE "chat_threads" ADD CONSTRAINT "chk_chat_threads_codex_service_tier" CHECK ("chat_threads"."codex_service_tier" IS NULL OR "chat_threads"."codex_service_tier" = 'fast') NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chk_chat_threads_codex_service_tier";--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_service_tiers" CHECK ("model_routes"."service_tiers" <@ ARRAY['priority']::text[] AND ("model_routes"."default_service_tier" IS NULL OR "model_routes"."default_service_tier" = ANY("model_routes"."service_tiers")));--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD CONSTRAINT "chk_org_members_metadata_service_tier" CHECK ("org_members_metadata"."service_tier" IS NULL OR "org_members_metadata"."service_tier" = 'priority') NOT VALID;--> statement-breakpoint
ALTER TABLE "org_members_metadata" VALIDATE CONSTRAINT "chk_org_members_metadata_service_tier";--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "chk_run_model_catalog_pi_route_class" CHECK ("run_model_catalog"."pi_route_class" IS NULL OR "run_model_catalog"."pi_route_class" = 'gpt-codex');