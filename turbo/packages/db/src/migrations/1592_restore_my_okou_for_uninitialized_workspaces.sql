-- Restore the default-on My Okou flag for four uninitialized workspaces.
-- Keep their legacy Agents and defer normal bootstrap to the next onboarding.
SET LOCAL TIME ZONE 'UTC';
--> statement-breakpoint
CREATE TEMP VIEW uninitialized_my_okou_eligible AS
WITH frozen AS (
  SELECT value->>0 AS member_key,value->>1 AS agents_key
  FROM jsonb_array_elements($cohort$
[
  [
    "10e801b3b67a6e289559a6711025df80d19b24d032a7fa7b299654489ab25075",
    "5eea06c636554515127ac07b3db3470dde872a70f8049311ab187c85038f88ba"
  ],
  [
    "5ff1729ea6d5069daac513fc3190c706134f753fa18af6579dc80d2b202651eb",
    "c1e131f9ba47e0e53922e61daf31a238018001098ae8cae81564920acffe3233"
  ],
  [
    "ef0cf18768102811f909652ce7fa6cfe33c2538f7d748061c737627992169dcc",
    "18651bd5300e652b67b5d137fc8a30bff0a972ffb4a7208618052599a470309c"
  ],
  [
    "f5e711246da4312b7fa75e4f418d08a72486a7c0043ceb22a0ca12b9cbd26dbb",
    "779367144925e028669089683413bc9586bb604d6c898dc9b658d4d006897d90"
  ]
]
$cohort$::jsonb)
)
SELECT f.org_id,f.user_id
FROM user_feature_switches f
JOIN org_members_metadata m USING(org_id,user_id)
JOIN frozen x ON x.member_key=encode(sha256(convert_to(f.org_id || ':' || f.user_id,'UTF8')),'hex')
WHERE f.switches->'singleAgent'='false'::jsonb
  AND NOT EXISTS (SELECT 1 FROM org_members_metadata other WHERE other.org_id=f.org_id AND other.user_id<>f.user_id)
  AND NOT EXISTS (SELECT 1 FROM org_members_cache other WHERE other.org_id=f.org_id AND other.user_id<>f.user_id)
  AND NOT EXISTS (SELECT 1 FROM org_metadata o WHERE o.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM org_plan_entitlements e WHERE e.org_id=f.org_id)
  AND x.agents_key=(
    SELECT encode(sha256(convert_to(string_agg(a.id::text,',' ORDER BY a.id),'UTF8')),'hex')
    FROM agents a WHERE a.org_id=f.org_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM agents a WHERE a.org_id=f.org_id
      AND (a.owner<>f.user_id OR a.visibility<>'public' OR a.name='default-agent')
  )
  AND NOT EXISTS (
    SELECT 1 FROM chat_threads c JOIN agents a ON a.id=c.agent_id WHERE a.org_id=f.org_id
  )
  AND NOT EXISTS (SELECT 1 FROM chat_threads c WHERE c.user_id=f.user_id AND c.agent_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM workflow_automations a WHERE a.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM queued_chat_threads q WHERE q.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM active_agent_runs r WHERE r.org_id=f.org_id)
  -- Enabling Single Agent can expose already-published gated Guide cards.
  -- Defer unseen eligible revisions instead of changing guides or their receipts.
  AND NOT EXISTS (
    SELECT 1 FROM feature_guide_editions e
    JOIN feature_guide_revisions r ON r.id = e.published_revision_id AND r.edition_id = e.id
    WHERE e.published_at IS NOT NULL AND (r.expires_at IS NULL OR r.expires_at > now())
      AND f.switches->'featureGuides' IS DISTINCT FROM 'false'::jsonb
      AND r.content->'items' @> '[{"featureSwitch":"singleAgent"}]'::jsonb
      AND (
        r.content->'audience' IS NULL
        OR r.content->'audience'->'orgIds' @> jsonb_build_array(f.org_id)
        OR r.content->'audience'->'users' @> jsonb_build_array(jsonb_build_object('orgId', f.org_id, 'userId', f.user_id))
      )
      AND NOT EXISTS (
        SELECT 1 FROM feature_guide_receipts receipt WHERE receipt.user_id = f.user_id AND receipt.edition_id = e.id
      )
  );
--> statement-breakpoint
UPDATE user_feature_switches f
SET switches=f.switches-'singleAgent',updated_at=now()
FROM uninitialized_my_okou_eligible eligible
WHERE f.org_id=eligible.org_id AND f.user_id=eligible.user_id
  AND f.switches->'singleAgent'='false'::jsonb;
--> statement-breakpoint
DROP VIEW uninitialized_my_okou_eligible;
