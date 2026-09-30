-- Keep the catalog order stable while adding Sol 6.1 between Luna and Sol 6.
-- The original 1291 seed remains immutable for databases that have applied it.
UPDATE "subscription_model_catalog"
SET "sort_order" = "sort_order" + 1,
    "updated_at" = now()
WHERE "subscription_type" = 'codex-oauth-token'
  AND "model" IN ('gpt-6-sol', 'gpt-6-astra');
--> statement-breakpoint
INSERT INTO "subscription_model_catalog" ("subscription_type", "model", "display_name", "efforts", "service_tier", "sort_order")
VALUES ('codex-oauth-token', 'gpt-6.1-sol', 'GPT 6.1 Sol', ARRAY['low','medium','high','xhigh','max'], 'priority', 2);
