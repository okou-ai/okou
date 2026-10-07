ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_provider_type";--> statement-breakpoint
ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_subscription_type";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "model_provider_id";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "model_provider_type";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "model_provider_credential_scope";--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_provider_type" CHECK ("model_routes"."provider_type" IN ('built-in', 'claude-code-oauth-token', 'codex-oauth-token'));--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_subscription_type" CHECK (CASE WHEN "model_routes"."provider_type" = 'built-in' THEN "model_routes"."subscription_type" IS NULL ELSE "model_routes"."subscription_type" IS NOT DISTINCT FROM "model_routes"."provider_type" END);