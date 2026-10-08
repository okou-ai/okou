ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_provider_type";--> statement-breakpoint
ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_concrete_provider_type";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_model_provider_id_model_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "model_providers" DROP CONSTRAINT "model_providers_secret_id_secrets_id_fk";
--> statement-breakpoint
DROP INDEX "idx_model_providers_secret";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "model_provider_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "selected_model";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "prefer_personal_provider";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "secret_id";--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" DROP COLUMN "support_byok";--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_provider_type" CHECK ("model_routes"."provider_type" IN ('claude-code-oauth-token', 'codex-oauth-token', 'built-in'));--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_concrete_provider_type" CHECK (CASE WHEN "model_routes"."provider_type" = 'built-in' THEN "model_routes"."concrete_provider_type" IN ('openrouter-codex') ELSE "model_routes"."concrete_provider_type" = "model_routes"."provider_type" END);