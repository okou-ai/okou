-- Catalog rows are listed by sort_order across subscription types, so use one
-- global order: Claude before GPT, strongest first within each provider.
UPDATE "subscription_model_catalog" AS "catalog"
SET "sort_order" = "target"."sort_order",
    "updated_at" = now()
FROM (VALUES
  ('claude-code-oauth-token', 'claude-fable-5-1', 1),
  ('claude-code-oauth-token', 'claude-opus-5-5', 2),
  ('claude-code-oauth-token', 'claude-sonnet-5-5', 3),
  ('codex-oauth-token', 'gpt-6-astra', 4),
  ('codex-oauth-token', 'gpt-6.1-sol', 5),
  ('codex-oauth-token', 'gpt-6-sol', 6),
  ('codex-oauth-token', 'gpt-6-luna', 7)
) AS "target" ("subscription_type", "model", "sort_order")
WHERE "catalog"."subscription_type" = "target"."subscription_type"
  AND "catalog"."model" = "target"."model";
