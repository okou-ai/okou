-- Increase the free tier's daily request allowance for shorter voice chunks.
-- Leave custom request limits and all other voice allowances unchanged.
UPDATE "org_plan_entitlements"
SET "audio_daily_rate_limit" = 40,
    "updated_at" = now()
WHERE "plan_key" = 'limited-free-1'
  AND "audio_daily_rate_limit" = 10;
