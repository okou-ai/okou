-- Staff members who opted into the Antigravity pilot run Gemini 4 with their
-- own connected Google AI account. Admission still requires the staff switch.
UPDATE "model_routes"
SET "enabled" = true, "updated_at" = now()
WHERE "provider_type" = 'antigravity'
  AND "subscription_type" = 'antigravity'
  AND "model" IN ('gemini-4-neon', 'gemini-4-carbon', 'gemini-4-hydrogen');
