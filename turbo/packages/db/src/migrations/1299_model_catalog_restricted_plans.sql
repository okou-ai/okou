ALTER TABLE "run_model_catalog" ADD COLUMN "built_in_on_restricted_plans" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD COLUMN "own_routes_on_restricted_plans" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Plan restriction formerly hard-coded in @okouai/api-contracts
-- (LIMITED_FREE1_ALLOWED_RUN_MODELS and getRunModelRouteAccess): restricted
-- plans run only these models on Built-in routes, and every model except
-- claude-sonnet-5-5 and gpt-6.1-sol on their own provider routes.
UPDATE "run_model_catalog" SET "built_in_on_restricted_plans" = true
WHERE "model" IN ('okou-1.0', 'gpt-6-luna', 'gpt-5.6-luna', 'deepseek-v4.1-flash', 'deepseek-v4-flash');--> statement-breakpoint
UPDATE "run_model_catalog" SET "own_routes_on_restricted_plans" = false
WHERE "model" IN ('claude-sonnet-5-5', 'gpt-6.1-sol');
