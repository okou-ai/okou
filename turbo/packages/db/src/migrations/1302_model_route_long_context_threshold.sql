ALTER TABLE "model_routes" ADD COLUMN "long_context_min_total_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "chk_model_routes_long_context_threshold" CHECK ("model_routes"."long_context_min_total_input_tokens" IS NULL OR ("model_routes"."provider_type" = 'built-in' AND "model_routes"."long_context_min_total_input_tokens" > 0));--> statement-breakpoint
-- Move the long-context pricing trigger from code onto the Built-in route it
-- bills. Until this migration the API resolved the threshold from the static
-- MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS map by the route's pricing
-- provider, then the catalog model, then the upstream model. This backfill
-- applies exactly that resolution to every Built-in route (enabled, disabled
-- and retired alike), so no route changes how it bills. Every map entry is
-- 272001 at this migration. Routes matching none of the keys stay NULL
-- (single tier), as before. Prices are untouched.
UPDATE "model_routes"
SET "long_context_min_total_input_tokens" = 272001
WHERE "provider_type" = 'built-in'
  AND (
    "pricing_provider" IN ('okou-1.0', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna')
    OR "model" IN ('okou-1.0', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna')
    OR "upstream_model" IN ('okou-1.0', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna')
  );
