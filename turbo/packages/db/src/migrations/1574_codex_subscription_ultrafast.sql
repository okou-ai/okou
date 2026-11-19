ALTER TABLE "chat_threads" DROP CONSTRAINT "chk_chat_threads_codex_service_tier";--> statement-breakpoint
ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_service_tiers";--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chk_chat_threads_codex_service_tier" CHECK ("chat_threads"."codex_service_tier" IS NULL OR "chat_threads"."codex_service_tier" IN ('fast', 'ultrafast'));--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_service_tiers" CHECK ("model_routes"."service_tiers" <@ CASE WHEN "model_routes"."subscription_type" = 'codex-oauth-token' THEN ARRAY['priority', 'ultrafast']::text[] ELSE ARRAY['priority']::text[] END AND ("model_routes"."default_service_tier" IS NULL OR "model_routes"."default_service_tier" = ANY("model_routes"."service_tiers")));
--> statement-breakpoint
UPDATE "model_routes"
SET "service_tiers" = array_append("service_tiers", 'ultrafast'),
    "updated_at" = now()
WHERE "provider_type" = 'codex-oauth-token'
  AND "subscription_type" = 'codex-oauth-token'
  AND "model" IN ('gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-astra')
  AND NOT ('ultrafast' = ANY("service_tiers"));
