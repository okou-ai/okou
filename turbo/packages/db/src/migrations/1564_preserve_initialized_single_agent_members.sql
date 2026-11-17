-- The retained cohort is initialized workspace memberships, not Clerk accounts.
-- Keep a selected membership alive until its override and migration journal commit.
WITH initialized_members AS MATERIALIZED (
  SELECT org_id, user_id
  FROM org_members_metadata
  ORDER BY org_id, user_id
  FOR KEY SHARE
), cleared_departed_overrides AS (
  -- Departures before this release may have left a personal override behind.
  -- An absent initialization is outside the retained cohort on a later rejoin.
  UPDATE user_feature_switches AS feature_switches
  SET switches = feature_switches.switches - 'singleAgent',
      updated_at = now()
  WHERE feature_switches.user_id <> '__org__'
    AND feature_switches.switches ? 'singleAgent'
    AND NOT EXISTS (
      SELECT 1 FROM initialized_members
      WHERE initialized_members.org_id = feature_switches.org_id
        AND initialized_members.user_id = feature_switches.user_id
    )
)
INSERT INTO user_feature_switches (org_id, user_id, switches)
SELECT org_id, user_id,
  -- This is the outgoing registry's staff audience, frozen for this migration.
  jsonb_build_object('singleAgent', org_id = 'org_3ANttyrbWYJk6JKRSTRLEsbsDLe')
FROM initialized_members
ON CONFLICT (org_id, user_id) DO UPDATE
SET switches = EXCLUDED.switches || user_feature_switches.switches,
    updated_at = now()
WHERE NOT (user_feature_switches.switches ? 'singleAgent');
