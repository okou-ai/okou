-- Pi memory no longer owns an independent managed model route.
-- Retain personal subscriptions, Auto, catalog metadata and historical pricing.
DELETE FROM "model_routes"
WHERE "model" = 'gpt-6-luna'
  AND "provider_type" = 'built-in'
  AND "concrete_provider_type" = 'openrouter-codex'
  AND "subscription_type" IS NULL
  AND "upstream_model" = 'openai/gpt-6-luna'
  AND "priority" = 1;
