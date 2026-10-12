-- Fixed API test baseline only; never applied by production migrations.
-- The same fake managed OpenRouter key dev-seed uses when no real key is
-- configured (scripts/dev-seed-managed-model-key.ts). It lets API tests prove
-- the managed key never reaches a sandbox or Runner; it is not a credential.
INSERT INTO built_in_model_keys (vendor, api_key, label)
VALUES ('openrouter', 'okou-fake-managed-model-key-sentinel-3f9c1e7a', 'api-test sentinel')
ON CONFLICT (vendor) DO NOTHING;
