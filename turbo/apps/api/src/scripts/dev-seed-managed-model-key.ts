/**
 * Obvious fake managed OpenRouter key. dev-seed falls back to it when no
 * DEV_MODEL_OPENROUTER_KEY is configured, and the fixed API test seed
 * (`test-fixtures/seeds/managed-model-key.sql`) inserts the same value so API
 * tests can prove the managed key never reaches a sandbox or Runner. It is
 * not a usable credential and must never be replaced with a real key.
 */
export const DEV_SEED_SENTINEL_MANAGED_MODEL_KEY =
  "okou-fake-managed-model-key-sentinel-3f9c1e7a";
