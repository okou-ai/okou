-- Add canonical identities before API promotion. Legacy rows and routes remain
-- readable by outgoing API and retained executions; no historical Run rewrite.
INSERT INTO run_model_catalog
  (model, display_name, sort_order, lineage_rank, built_in_on_restricted_plans, pi_route_class)
SELECT 'auto', 'Auto', 0, max(lineage_rank) + 1, true, 'gpt-codex'
FROM run_model_catalog
ON CONFLICT (model) DO NOTHING;
--> statement-breakpoint
INSERT INTO model_routes
  (model, provider_type, concrete_provider_type, subscription_type, upstream_model,
   enabled, priority, service_tiers, default_service_tier, efforts, default_effort,
   pricing_kind, pricing_provider, long_context_min_total_input_tokens)
SELECT 'auto', provider_type, concrete_provider_type, subscription_type, upstream_model,
  enabled, priority, ARRAY[]::text[], NULL, ARRAY[]::text[], NULL,
  pricing_kind, upstream_model, 100001
FROM model_routes
WHERE model = 'okou-1.0' AND provider_type = 'built-in'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE run_model_catalog AS legacy
SET replaced_by = canonical.model, replaced_by_lineage_rank = canonical.lineage_rank,
    updated_at = now()
FROM run_model_catalog AS canonical
WHERE canonical.model = 'auto'
  AND (legacy.replaced_by = 'okou-1.0' OR legacy.model IN ('okou-1.0-pro', 'okou-1.0-max'));
