ALTER TABLE "run_model_catalog" ADD COLUMN "built_in_on_restricted_plans" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Free plans (restricted_built_in_models) run only okou-1.0 on Built-in
-- routes. Every other model, and every model added later, is paid-only on
-- Built-in. This replaces the former code allowlist
-- (LIMITED_FREE1_ALLOWED_RUN_MODELS) rather than reproducing it.
UPDATE "run_model_catalog" SET "built_in_on_restricted_plans" = true
WHERE "model" = 'okou-1.0';--> statement-breakpoint
-- Legacy Free (plan_key 'free') predates the restricted capability and was
-- left unrestricted. Both free plans now share the same model access.
UPDATE "org_plan_entitlements" SET "restricted_built_in_models" = true, "updated_at" = now()
WHERE "plan_key" = 'free' AND "restricted_built_in_models" = false;
