-- Custom SQL migration file, put your code below! --
-- Internal memory uses the existing OpenRouter Luna model and pricing.
-- Foreground Built-in admission remains fixed Auto. Keep the DeepSeek route
-- and all prices for captured maintenance runs and overlapping/rollback APIs.
INSERT INTO "model_routes" (
  "model", "provider_type", "concrete_provider_type", "subscription_type",
  "upstream_model", "enabled", "priority", "service_tiers",
  "default_service_tier", "efforts", "default_effort", "pricing_kind",
  "pricing_provider", "long_context_min_total_input_tokens"
)
VALUES (
  'gpt-6-luna', 'built-in', 'openrouter-codex', NULL,
  'openai/gpt-6-luna', true, 1, ARRAY['priority']::text[],
  NULL, ARRAY['low', 'medium', 'high', 'xhigh']::text[], 'xhigh', 'model',
  'gpt-6-luna', 272001
);
