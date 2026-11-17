-- Fixed three-workspace pilot for #45475. All eligibility comes from this DB.
-- Reuse the deployed prefixed Instruction-package reader from #46786.
-- No ordinary Workflows, attachments, Automations, queued or active work are admitted.
-- Retain source Agents, Instructions, immutable bundles and historical Run identities.
-- This file and its journal commit together; no Feature Guide is delivered.
-- Existing timestamps are UTC without a zone; make the 30-day boundary explicit.
SET LOCAL TIME ZONE 'UTC';

CREATE FUNCTION pg_temp.inactive_copy_uuid(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT overlay(overlay(md5(value) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$fn$;

CREATE TEMP TABLE inactive_pilot_cohort (
  org_id text PRIMARY KEY, user_id text NOT NULL,
  default_agent_id uuid NOT NULL, source_agent_id uuid NOT NULL
) ON COMMIT DROP;
INSERT INTO inactive_pilot_cohort VALUES
  ('org_3ElmWW9ufwzlOcPTdytaoKm9oxO', 'user_3ElmWQ4cVUb26MaNwNI00iqXrmD', '98abdb11-aebd-454b-9f32-089655172bdb', 'd48e60df-4025-40f4-8786-cbc48291f725'),
  ('org_3EtVxBPpkYr6rCc1ijZTqKAvvtl', 'user_3EtVxE4JFygkWcL6vNusRAlPlwQ', '429c2e1e-190f-4b66-8b7e-7d9c307afc2d', '6cad84fa-48f3-4b88-ab15-42e3fef83b16'),
  ('org_3FRjmZNjDFnjrGQNNAS5eeTgr3J', 'user_3FRjmYpULBGOc0l7w97IjmDHOqi', 'd0876472-925a-4b0f-8a71-6d00bbce137c', '34dad90a-14f2-4f2a-a043-712f69e0a7a3');

-- A changed/ineligible workspace is skipped, never replaced with another org.
-- now() is the same transaction clock for every 30-day predicate in this file.
CREATE TEMP TABLE inactive_copy_target ON COMMIT DROP AS
SELECT c.*, a.instructions, a.instructions_bundle
FROM inactive_pilot_cohort c
JOIN org_metadata o ON o.org_id=c.org_id AND o.default_agent_id=c.default_agent_id
JOIN agents a ON a.id=c.default_agent_id AND a.org_id=c.org_id
  AND a.owner=c.user_id AND a.visibility='public'
JOIN agents source ON source.id=c.source_agent_id AND source.org_id=c.org_id
  AND source.owner=c.user_id AND source.visibility='public'
JOIN org_members_metadata m ON m.org_id=c.org_id AND m.user_id=c.user_id
JOIN org_members_cache cache ON cache.org_id=c.org_id AND cache.user_id=c.user_id AND cache.role='admin'
JOIN user_feature_switches f ON f.org_id=c.org_id AND f.user_id=c.user_id
WHERE o.created_at < now()-interval '30 days'
  AND m.created_at < now()-interval '30 days'
  AND f.switches->'singleAgent'='false'::jsonb
  AND a.instructions_bundle IS NOT NULL AND source.instructions_bundle IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM org_members_metadata x WHERE x.org_id=c.org_id AND x.user_id<>c.user_id)
  AND NOT EXISTS (SELECT 1 FROM org_members_cache x WHERE x.org_id=c.org_id AND x.user_id<>c.user_id)
  AND NOT EXISTS (SELECT 1 FROM agents x WHERE x.org_id=c.org_id AND x.id NOT IN (c.default_agent_id,c.source_agent_id))
  AND NOT EXISTS (SELECT 1 FROM workflows x WHERE x.org_id=c.org_id)
  AND NOT EXISTS (SELECT 1 FROM workflow_automations x WHERE x.org_id=c.org_id)
  AND NOT EXISTS (SELECT 1 FROM projects x WHERE x.org_id=c.org_id)
  AND NOT EXISTS (SELECT 1 FROM queued_chat_threads x WHERE x.org_id=c.org_id)
  AND NOT EXISTS (SELECT 1 FROM active_agent_runs x WHERE x.org_id=c.org_id)
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.org_id=c.org_id
    AND (r.created_at >= now()-interval '30 days' OR r.status IN ('pending','running')))
  AND (SELECT count(*) FROM chat_threads x WHERE x.agent_id=c.source_agent_id)=1
  AND NOT EXISTS (SELECT 1 FROM chat_threads x WHERE x.agent_id=c.source_agent_id
    AND (x.user_id<>c.user_id OR x.project_id IS NOT NULL));

CREATE TEMP TABLE inactive_copy_agents ON COMMIT DROP AS
SELECT a.*, t.default_agent_id AS target_agent_id,
  coalesce(nullif(btrim(a.display_name),''),a.name) AS project_label
FROM agents a JOIN inactive_copy_target t ON a.id=t.source_agent_id AND a.org_id=t.org_id;

CREATE TEMP TABLE inactive_copy_chat_routes ON COMMIT DROP AS
SELECT c.id, c.user_id, c.agent_id AS source_agent_id, a.org_id,
  a.target_agent_id, a.project_label AS project_name,
  pg_temp.inactive_copy_uuid('inactive-single-agent-project-v1:' || a.org_id || ':' || c.user_id || ':' || a.id::text) AS project_id
FROM chat_threads c JOIN inactive_copy_agents a ON c.agent_id=a.id;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_chat_routes WHERE length(btrim(project_name)) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'Inactive pilot Project label is outside the product contract';
  END IF;
END $$;

-- The source package stays immutable. The existing Guest document adapter
-- materializes instructions.md as the named SKILL.md for --instruction mounts.
INSERT INTO workflows (id,org_id,agent_id,name,visibility,instruction,attachments,content_bundle,
  owner_user_id,created_by,updated_by,created_at,updated_at)
SELECT pg_temp.inactive_copy_uuid('inactive-single-agent-instruction-v1:' || a.id::text),
  a.org_id,a.target_agent_id,'legacy--instruction',a.visibility,a.instructions,
  '{"kind":"empty"}'::jsonb,a.instructions_bundle,a.owner,a.owner,a.owner,a.created_at,now()
FROM inactive_copy_agents a ON CONFLICT (id) DO NOTHING;

-- Preserve every saved personal value, including deliberately empty content.
INSERT INTO instructions (org_id,user_id,content,bundle)
SELECT org_id,user_id,instructions,instructions_bundle FROM inactive_copy_target
ON CONFLICT (org_id,user_id) DO NOTHING;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_agents a LEFT JOIN workflows w
    ON w.id=pg_temp.inactive_copy_uuid('inactive-single-agent-instruction-v1:' || a.id::text)
    WHERE w.id IS NULL OR w.org_id<>a.org_id OR w.agent_id<>a.target_agent_id
      OR w.owner_user_id<>a.owner OR w.visibility<>a.visibility OR w.name<>'legacy--instruction'
      OR w.instruction IS DISTINCT FROM a.instructions
      OR w.content_bundle IS DISTINCT FROM a.instructions_bundle
      OR w.attachments IS DISTINCT FROM '{"kind":"empty"}'::jsonb) THEN
    RAISE EXCEPTION 'Inactive pilot Instruction Workflow identity collision';
  END IF;
END $$;

WITH inserted AS (
  INSERT INTO projects (id,user_id,org_id,name)
  SELECT project_id,user_id,org_id,project_name FROM inactive_copy_chat_routes
  ON CONFLICT (id) DO NOTHING RETURNING *
), counts AS (
  SELECT user_id,org_id,count(*)::bigint AS total FROM inserted GROUP BY user_id,org_id
), reserved AS (
  INSERT INTO project_event_sequences (user_id,org_id,last_seq_id)
  SELECT user_id,org_id,total FROM counts
  ON CONFLICT (user_id,org_id) DO UPDATE SET last_seq_id=project_event_sequences.last_seq_id+EXCLUDED.last_seq_id
  RETURNING user_id,org_id,last_seq_id
)
INSERT INTO project_events (id,user_id,org_id,seq_id,project_id,kind,name)
SELECT gen_random_uuid(),p.user_id,p.org_id,
  r.last_seq_id-c.total+row_number() OVER (PARTITION BY p.user_id,p.org_id ORDER BY p.id),
  p.id,'created',p.name FROM inserted p JOIN counts c USING(user_id,org_id) JOIN reserved r USING(user_id,org_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_chat_routes r LEFT JOIN projects p ON p.id=r.project_id
    WHERE p.id IS NULL OR p.org_id<>r.org_id OR p.user_id<>r.user_id OR p.name<>r.project_name) THEN
    RAISE EXCEPTION 'Inactive pilot Project identity belongs to another source';
  END IF;
END $$;

WITH updated AS (
  UPDATE chat_threads c SET agent_id=r.target_agent_id,project_id=r.project_id,updated_at=now()
  FROM inactive_copy_chat_routes r
  WHERE c.id=r.id AND c.user_id=r.user_id AND c.agent_id=r.source_agent_id AND c.project_id IS NULL
  RETURNING c.*
), scoped AS (
  SELECT u.*,r.org_id FROM updated u JOIN inactive_copy_chat_routes r ON r.id=u.id
), counts AS (
  SELECT user_id,org_id,2*count(*)::bigint AS total FROM scoped GROUP BY user_id,org_id
), reserved AS (
  INSERT INTO chat_thread_event_sequences (user_id,org_id,last_seq_id)
  SELECT user_id,org_id,total FROM counts
  ON CONFLICT (user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+EXCLUDED.last_seq_id
  RETURNING user_id,org_id,last_seq_id
)
INSERT INTO chat_thread_events (id,user_id,org_id,seq_id,chat_thread_id,kind,agent_id,
  reassigned_agent_id,project_id,pin_order,created_at)
SELECT gen_random_uuid(),p.user_id,p.org_id,
  r.last_seq_id-c.total+row_number() OVER (PARTITION BY p.user_id,p.org_id ORDER BY p.id,event.ordinal),
  p.id,CASE WHEN event.ordinal=1 THEN 'project_updated' ELSE 'sort_touched' END::chat_thread_event_kind,
  p.agent_id,CASE WHEN event.ordinal=2 THEN p.agent_id ELSE NULL END,
  CASE WHEN event.ordinal=1 THEN p.project_id ELSE NULL END,
  CASE WHEN event.ordinal=2 THEN p.pin_order ELSE NULL END,
  CASE WHEN event.ordinal=1 THEN p.updated_at ELSE p.last_message_at END
FROM scoped p JOIN counts c USING(user_id,org_id) JOIN reserved r USING(user_id,org_id)
CROSS JOIN (VALUES (1),(2)) event(ordinal);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_chat_routes r LEFT JOIN chat_threads c ON c.id=r.id
    WHERE c.id IS NULL OR c.agent_id<>r.target_agent_id OR c.project_id IS DISTINCT FROM r.project_id)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t JOIN agent_runs r ON r.org_id=t.org_id
      WHERE r.created_at >= now()-interval '30 days' OR r.status IN ('pending','running'))
    OR EXISTS (SELECT 1 FROM inactive_copy_target t JOIN queued_chat_threads q ON q.org_id=t.org_id)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t JOIN active_agent_runs a ON a.org_id=t.org_id)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t JOIN workflow_automations a ON a.org_id=t.org_id) THEN
    RAISE EXCEPTION 'Inactive pilot changed during cutover; transaction must not activate it';
  END IF;
END $$;

-- Activate only the reviewed initialized member; keep every unrelated switch.
UPDATE user_feature_switches f
SET switches=f.switches || '{"singleAgent":true}'::jsonb,updated_at=now()
FROM inactive_copy_target t WHERE f.org_id=t.org_id AND f.user_id=t.user_id;

DROP FUNCTION pg_temp.inactive_copy_uuid(text);
