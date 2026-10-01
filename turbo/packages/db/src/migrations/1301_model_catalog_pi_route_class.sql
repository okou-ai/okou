ALTER TABLE "run_model_catalog" ADD COLUMN "pi_route_class" varchar(32);--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "chk_run_model_catalog_pi_route_class" CHECK ("run_model_catalog"."pi_route_class" IS NULL OR "run_model_catalog"."pi_route_class" IN ('claude-native', 'gpt-codex', 'deepseek'));--> statement-breakpoint
-- Pi eligibility formerly hard-coded in @okouai/core (PI_MODEL_POLICY). The
-- frontier lines claude-fable-5-1 and gpt-6-astra stay on their vendor
-- harness, and retired or unrecognized rows are never executed, so they keep
-- NULL (not Pi-eligible), the default for every new model.
UPDATE "run_model_catalog" SET "pi_route_class" = 'claude-native'
WHERE "model" IN ('claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5');--> statement-breakpoint
UPDATE "run_model_catalog" SET "pi_route_class" = 'gpt-codex'
WHERE "model" IN ('okou-1.0', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna');--> statement-breakpoint
UPDATE "run_model_catalog" SET "pi_route_class" = 'deepseek'
WHERE "model" IN ('deepseek-v4.1-flash', 'deepseek-v4-flash');
