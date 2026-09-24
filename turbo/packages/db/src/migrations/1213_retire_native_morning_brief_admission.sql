-- Preserve other overrides while revoking explicit native admission for every
-- owner, including staff and former test cohorts. The API now rejects fresh
-- true overrides; old API instances may still write them during promotion, so
-- rollout acceptance must check again after those instances drain.
UPDATE "user_feature_switches"
SET "switches" = jsonb_set("switches", '{simpleMorningBrief}', 'false'::jsonb),
    "updated_at" = now()
WHERE "switches" @> '{"simpleMorningBrief": true}'::jsonb;
