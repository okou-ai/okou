-- Enable My Okou for the reviewed existing members of empty workspaces.
-- Normal onboarding still creates workspace data and the canonical Agent.
SET LOCAL TIME ZONE 'UTC';
--> statement-breakpoint
CREATE TEMP VIEW empty_my_okou_eligible AS
WITH frozen AS (
  SELECT jsonb_array_elements_text($cohort$
[
  "35ebb6b8c4d4c1f182ffa157f54062a427f8a4bb1665a2db9fd2ad6884687ef0",
  "5fb2cd44f5ef2bc9cbc2bf16c0228160b0d704886afd7eba3b5037d3453d7ef2",
  "69e504508aafd89d82df7e9000df16a80c972db6dc1c79bd8e692f830d7af107",
  "7ecf4ff065c7773064f144adf6880e841db600eba07d2be90e7c3dac81607ad9",
  "a83a1bacf71d2340f174b061ae27a52f350f0fc66f9b638b4f1110cfdfa806f1",
  "b2a5554fefe0be59bb2ee57f8bca9a1828ea392c33331ae38ccbebd216cd1dfa"
]
$cohort$::jsonb) AS cohort_key
)
SELECT f.org_id,f.user_id
FROM user_feature_switches f
JOIN org_members_metadata m USING(org_id,user_id)
JOIN frozen x ON x.cohort_key=encode(sha256(convert_to(f.org_id || ':' || f.user_id,'UTF8')),'hex')
WHERE f.switches->'singleAgent'='false'::jsonb
  AND NOT EXISTS (SELECT 1 FROM org_members_metadata other WHERE other.org_id=f.org_id AND other.user_id<>f.user_id)
  AND NOT EXISTS (SELECT 1 FROM org_members_cache other WHERE other.org_id=f.org_id AND other.user_id<>f.user_id)
  AND NOT EXISTS (SELECT 1 FROM org_metadata o WHERE o.org_id=f.org_id AND o.default_agent_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.org_id=f.org_id)
  AND NOT EXISTS (SELECT 1 FROM chat_threads c WHERE c.user_id=f.user_id)
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
SET switches=f.switches || '{"singleAgent":true}'::jsonb,updated_at=now()
FROM empty_my_okou_eligible eligible
WHERE f.org_id=eligible.org_id AND f.user_id=eligible.user_id
  AND f.switches->'singleAgent'='false'::jsonb;
--> statement-breakpoint
DROP VIEW empty_my_okou_eligible;
