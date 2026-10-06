-- Native subscription mirrors previously inherited these defaults from the
-- now-retired non-subscription routes (1298_global_model_catalog.sql).
-- Preserve that launch behavior on the canonical personal subscription routes.
-- Do not change explicit defaults, disabled/future routes, Auto, memory, or
-- member preferences. Luna's separately migrated xhigh ceiling stays intact.
WITH native_defaults(model, provider_type, default_effort) AS (
  VALUES
    ('claude-fable-5-1', 'claude-code-oauth-token', 'max'),
    ('claude-opus-5-5', 'claude-code-oauth-token', 'medium'),
    ('claude-sonnet-5-5', 'claude-code-oauth-token', 'high'),
    ('gpt-6-astra', 'codex-oauth-token', 'max'),
    ('gpt-6-sol', 'codex-oauth-token', 'max'),
    ('gpt-6.1-sol', 'codex-oauth-token', 'medium')
)
UPDATE model_routes AS route
SET default_effort = defaults.default_effort
FROM native_defaults AS defaults, run_model_catalog AS catalog
WHERE route.model = defaults.model
  AND route.provider_type = defaults.provider_type
  AND route.concrete_provider_type = defaults.provider_type
  AND route.subscription_type = defaults.provider_type
  AND route.upstream_model = route.model
  AND route.enabled
  AND route.default_effort IS NULL
  AND defaults.default_effort = ANY(route.efforts)
  AND catalog.model = route.model
  AND catalog.replaced_by IS NULL;
