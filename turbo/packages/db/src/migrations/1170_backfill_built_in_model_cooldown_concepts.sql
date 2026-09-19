UPDATE "built_in_model_candidate_cooldown"
SET
  "model_runtime_provider" = COALESCE(
    "model_runtime_provider",
    "provider_type"
  ),
  "model_runtime_model" = COALESCE("model_runtime_model", "upstream_model")
WHERE "model_runtime_provider" IS NULL OR "model_runtime_model" IS NULL;
