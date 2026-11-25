-- Fixed API test baseline only; never applied by production migrations.
-- The same fake managed OpenRouter key dev-seed uses when no real key is
-- configured (scripts/dev-seed-managed-model-key.ts). It lets API tests prove
-- the managed key never reaches a sandbox or Runner; it is not a credential.
-- Platform-paid Official Runs use a separate fake key so tests can tell the
-- two managed keys apart.
INSERT INTO built_in_model_keys (vendor, api_key, label)
VALUES
  ('openrouter', 'okou-fake-managed-model-key-sentinel-3f9c1e7a', 'api-test sentinel'),
  ('openrouter-proactive', 'okou-fake-proactive-model-key-sentinel-8d2b6f41', 'api-test proactive sentinel')
ON CONFLICT (vendor) DO NOTHING;
