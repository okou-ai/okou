ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_provider_type";--> statement-breakpoint
ALTER TABLE "model_routes" DROP CONSTRAINT "chk_model_routes_subscription_type";--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_provider_type" CHECK ("model_routes"."provider_type" IN ('claude-code-oauth-token', 'codex-oauth-token', 'antigravity', 'built-in'));--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_subscription_type" CHECK (("model_routes"."subscription_type" IS NULL AND "model_routes"."provider_type" <> 'antigravity') OR ("model_routes"."subscription_type" IS NOT NULL AND "model_routes"."provider_type" <> 'built-in' AND "model_routes"."subscription_type" = "model_routes"."provider_type"));--> statement-breakpoint
-- Register the pilot as one cohort. Subscription routes stay disabled until
-- admission can bind a run to the initiating member's Google AI account.
WITH pilot (model, display_name, sort_order, efforts) AS (
  VALUES
    ('gemini-4-neon', 'Gemini 4 Neon', 230, ARRAY['low', 'medium', 'high', 'xhigh']),
    ('gemini-4-carbon', 'Gemini 4 Carbon', 240, ARRAY['low', 'medium', 'high']),
    ('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 250, ARRAY['low', 'medium', 'high', 'xhigh'])
), registered AS (
  INSERT INTO run_model_catalog (model, display_name, sort_order, lineage_rank)
  SELECT model, display_name, sort_order, 100 FROM pilot
  ON CONFLICT (model) DO UPDATE SET
    display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order
  RETURNING model
)
INSERT INTO model_routes (
  model, provider_type, concrete_provider_type, subscription_type, upstream_model,
  enabled, service_tiers, efforts, default_effort
)
SELECT
  pilot.model, 'antigravity', 'antigravity', 'antigravity', pilot.model,
  false, ARRAY[]::text[], pilot.efforts, 'medium'
FROM pilot
JOIN registered USING (model)
ON CONFLICT ON CONSTRAINT uq_model_routes_identity DO NOTHING;
