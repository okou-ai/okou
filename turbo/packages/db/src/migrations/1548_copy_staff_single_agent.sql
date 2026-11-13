-- Staff-only online copy. Deploy the compatibility readers before this migration.
-- Prerequisite: #46786 serving on API/Runner, outgoing API requests drained,
-- and incompatible Runners drained and exited. Cleanup: #46783.
-- R2 packages stay immutable; source Agents/Workflows remain available to old Runs.
-- Copied Workflows become independent definitions; later source edits are not synced.
-- The migration runner commits this file and its journal entry together. No writers
-- are disabled, no active/queued work is deleted, and no other organization changes.
SET LOCAL statement_timeout = '60s';

-- Stable RFC 4122 UUIDs; raw md5::uuid can fail public API UUID validation.
CREATE FUNCTION pg_temp.staff_copy_uuid(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT overlay(overlay(md5(value) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$fn$;

CREATE TEMP TABLE staff_copy_prefixes (agent_id uuid PRIMARY KEY, prefix text NOT NULL) ON COMMIT DROP;
INSERT INTO staff_copy_prefixes VALUES
  ('0300e951-f501-4856-8f4c-09fdc34ce651'::uuid, 'experiment'),
  ('06ba1ce5-3ed2-417b-a5c9-cc96a35b1d43'::uuid, 'kol-master'),
  ('13c99f5b-2d08-4ddd-83ca-c0b71923a463'::uuid, 'xiaoma'),
  ('1411317f-bc80-4fc8-aa09-45814df7f659'::uuid, 'okou-for-ser'),
  ('146ca722-aca5-4644-b7ff-907cf4c8b9ff'::uuid, 'pb-r10-v4-wa'),
  ('15474077-eb60-4e63-892b-0991e2a8e9d4'::uuid, 'alexandar-sa'),
  ('1630a9a5-c595-4fb0-8f71-822e1a472e57'::uuid, 'okou-for-ann'),
  ('16ef8895-3c9d-4d8d-9d36-4cdd811b1822'::uuid, 'lucas'),
  ('1cdf8dff-6110-476b-9f4a-afdcfa7a52df'::uuid, 'anders'),
  ('1ea11056-5ea4-4c87-a176-e7877196f813'::uuid, 'flux'),
  ('255b894a-d35c-4a9c-ba7d-a085585516e1'::uuid, 'ada-255b894a'),
  ('2774aa38-167e-4c85-9145-3495e332fd77'::uuid, 'lead-scout'),
  ('289eccea-8c20-4ad6-a994-8df3b8b95a0b'::uuid, 'finance'),
  ('2ca64b7c-e769-4573-82a0-f6264996e61c'::uuid, 'speaking-hea'),
  ('39ab1a52-1677-431a-b4bd-9c91cd0a333f'::uuid, 'design'),
  ('3a7792b2-1357-44fa-9f36-4a735394b170'::uuid, 'design-news'),
  ('3e99606b-da4d-410c-a9b0-8f07abecd841'::uuid, 'ops'),
  ('3f76ba42-b20e-4f4a-bd83-467612d34466'::uuid, 'travel-maste'),
  ('5181a05e-16c6-40b3-91aa-bf7dbb6fc1ab'::uuid, 'outreach-wri'),
  ('5c617644-655a-467b-8c23-a19ad7a9fc74'::uuid, 'pb-r10-v4-lu'),
  ('5da70f84-5254-4f0f-83a8-5c6985c36304'::uuid, 'admin'),
  ('638a2f6a-9dc4-4694-a107-1faee4ff5d90'::uuid, 'legal'),
  ('63b61fec-ab07-4a27-9c3c-bf86b00721dd'::uuid, 'biance'),
  ('6792394d-820a-4ca2-bb38-23af1680948c'::uuid, 'coor'),
  ('68ffc822-0f12-42dd-8f9f-c16d73c78297'::uuid, 'ebby'),
  ('6cf1d8f0-79c8-4e6a-8d1b-6d36c55f6850'::uuid, 'hi'),
  ('6f4e1fe5-8cfb-40fd-8caf-d6e2da65247f'::uuid, 'hr'),
  ('7256c3d9-81c0-4876-b551-e7a0f2f42e2b'::uuid, 'independent'),
  ('743e30cf-1b4c-4bab-8ac8-1e6504fe7a82'::uuid, 'sm-expert'),
  ('787f5c74-095b-401c-9e0c-8d1c3adcdd7c'::uuid, 'illustrator'),
  ('8fbe929f-97e0-4d5b-bd3f-32bbd4890927'::uuid, 'slides-bench'),
  ('94625906-621c-4c1b-9ae7-01073a7fb63c'::uuid, 'creator'),
  ('9887e448-ce1b-47f1-baed-d6032a844b98'::uuid, 'agent'),
  ('a18b9a2a-7846-4afb-bc9c-ec103a964a11'::uuid, 'emily'),
  ('a2dc59f0-3e72-474c-9eda-929b07f1821d'::uuid, 'compliance'),
  ('a7374890-a316-4055-8c0c-dbed222151d6'::uuid, 'presentation'),
  ('a849d724-d7df-4c18-86fb-dce92e6e0be2'::uuid, 'buffett'),
  ('ad86a09d-e341-431f-ae40-f43f9d72baab'::uuid, 'mini-games'),
  ('b21d73a3-68bd-4a64-959e-e2976fe83561'::uuid, 'okou-for-rom'),
  ('b294580c-a99e-4032-a0b0-b93b412e16f7'::uuid, 'ada-b294580c'),
  ('b9943f45-9599-46af-b65d-37875f95c846'::uuid, 'kaya'),
  ('bf28fc59-7533-4373-8e0d-7b268d27358f'::uuid, 'vlog'),
  ('c241b557-4f38-4da4-977b-43e1dbcbe393'::uuid, 'jackson'),
  ('cd703a9f-aca8-4644-bc76-38ba43609e42'::uuid, 'nova'),
  ('d1011b80-9c9b-4361-ad08-1747c688d106'::uuid, 'tcm-expert'),
  ('d280a320-8c65-4ae9-8d45-fe092c0062e4'::uuid, 'genius'),
  ('d6d0302e-7346-4615-83f8-5577fdff7889'::uuid, 'lisa'),
  ('db809985-cc04-42a7-9722-c37c17067eb8'::uuid, 'spark'),
  ('dd433107-15e6-42b7-8697-469c3399e3b5'::uuid, 'demo-analyst'),
  ('dd52a82a-1eb1-4381-ae55-f54332cf8092'::uuid, 'trump-info'),
  ('ddbe9a9d-a3bc-4c96-8d84-0d721a74b430'::uuid, 'growth-resea'),
  ('deda3c88-4c27-4298-bef9-3886eb856232'::uuid, 'tony'),
  ('e09a0e2c-4bee-461a-a050-55741e9f25a9'::uuid, 'pixel'),
  ('ebb41e0e-e0ca-478b-9d18-7cdbd1bbad7f'::uuid, 'haidian'),
  ('eef8fd6f-a994-4233-b51d-9534721db246'::uuid, 'noic'),
  ('efd9d58f-20ee-46fa-b49b-63c3a5b05237'::uuid, 'dash'),
  ('f8582d04-0824-4cf5-9d1c-7b2d06042fe2'::uuid, 'screencast-p'),
  ('fd607f8d-5c94-4839-a464-81c9b7997339'::uuid, 'iris');

CREATE TEMP TABLE staff_copy_target ON COMMIT DROP AS
SELECT m.org_id, a.id AS target_agent_id, a.instructions, a.instructions_bundle
FROM org_metadata m JOIN agents a ON a.id = m.default_agent_id AND a.org_id = m.org_id
WHERE m.org_id = 'org_3ANttyrbWYJk6JKRSTRLEsbsDLe' AND a.visibility = 'public';

DO $$ BEGIN
  IF (EXISTS (SELECT 1 FROM org_metadata WHERE org_id = 'org_3ANttyrbWYJk6JKRSTRLEsbsDLe')
      OR EXISTS (SELECT 1 FROM agents WHERE org_id = 'org_3ANttyrbWYJk6JKRSTRLEsbsDLe'))
    AND NOT EXISTS (SELECT 1 FROM staff_copy_target) THEN
    RAISE EXCEPTION 'Staff migration requires its public default executor';
  END IF;
  IF EXISTS (SELECT 1 FROM agents a JOIN staff_copy_target t ON a.org_id = t.org_id
    LEFT JOIN staff_copy_prefixes p ON p.agent_id = a.id
    WHERE a.id <> t.target_agent_id AND p.agent_id IS NULL) THEN
    RAISE EXCEPTION 'Staff Agent prefix census changed; review the new source before cutover';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_copy_target WHERE instructions_bundle IS NULL) THEN
    RAISE EXCEPTION 'Staff default Instructions have no immutable package';
  END IF;
END $$;

CREATE TEMP TABLE staff_copy_agents ON COMMIT DROP AS
SELECT a.*, p.prefix, coalesce(nullif(a.display_name, ''), a.name) AS project_label,
  count(*) OVER (PARTITION BY coalesce(nullif(a.display_name, ''), a.name)) AS label_count
FROM agents a JOIN staff_copy_target t ON a.org_id = t.org_id AND a.id <> t.target_agent_id
JOIN staff_copy_prefixes p ON p.agent_id = a.id;

CREATE TEMP TABLE staff_copy_workflows ON COMMIT DROP AS
SELECT w.*, pg_temp.staff_copy_uuid('staff-single-agent-workflow-v1:' || w.id::text) AS copy_id,
  t.target_agent_id,
  CASE WHEN length(a.prefix || '--wf-' || w.name) <= 64 THEN a.prefix || '--wf-' || w.name
    ELSE a.prefix || '--wf-' || rtrim(left(w.name, 64-length(a.prefix)-5-9), '-') || '-' ||
      left(encode(sha256(convert_to('["' || a.id::text || '","' || w.name || '"]', 'UTF8')), 'hex'), 8)
  END AS copy_name,
  CASE WHEN a.visibility = 'private' THEN a.owner ELSE w.owner_user_id END AS copy_owner,
  CASE WHEN a.visibility = 'private' THEN 'private' ELSE w.visibility END AS copy_visibility,
  a.visibility AS source_agent_visibility, a.owner AS source_agent_owner
FROM workflows w JOIN staff_copy_agents a ON a.id = w.agent_id AND a.org_id = w.org_id
JOIN staff_copy_target t ON t.org_id = w.org_id;

DO $$ BEGIN
  IF EXISTS (
    SELECT owner AS user_id,org_id FROM staff_copy_agents
    UNION SELECT owner_user_id,org_id FROM staff_copy_workflows
    UNION SELECT c.user_id,a.org_id FROM chat_threads c JOIN staff_copy_agents a ON a.id=c.agent_id
    EXCEPT SELECT user_id,org_id FROM org_members_cache
  ) THEN
    RAISE EXCEPTION 'Staff source owner membership changed; refresh the migration census';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_copy_workflows WHERE official_definition_name IS NOT NULL
    OR instruction IS NULL OR content_bundle IS NULL OR attachments IS NULL) THEN
    RAISE EXCEPTION 'Staff source Workflow is Official or has incomplete canonical content';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_copy_agents WHERE instructions_bundle IS NULL) THEN
    RAISE EXCEPTION 'Staff source Instructions have no immutable package';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_copy_workflows WHERE copy_name !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'
    OR length(copy_name) > 64) THEN
    RAISE EXCEPTION 'Staff target Workflow name is invalid';
  END IF;
END $$;

-- Preserve source attribution and all shared immutable content descriptors.
INSERT INTO workflows (id, org_id, agent_id, name, visibility, instruction, attachments, content_bundle,
  owner_user_id, display_name, description, official_definition_name, official_installation_state,
  import_source, import_session_id, created_by, updated_by, created_at, updated_at)
SELECT copy_id, org_id, target_agent_id, copy_name, copy_visibility, instruction, attachments, content_bundle,
  copy_owner, display_name, description, NULL, NULL, import_source, import_session_id,
  created_by, updated_by, created_at, timezone('UTC',statement_timestamp())
FROM staff_copy_workflows ON CONFLICT (id) DO NOTHING;

INSERT INTO workflows (id, org_id, agent_id, name, visibility, instruction, attachments, content_bundle,
  owner_user_id, created_by, updated_by, created_at, updated_at)
SELECT pg_temp.staff_copy_uuid('staff-single-agent-instruction-v1:' || a.id::text), a.org_id, t.target_agent_id,
  a.prefix || '--instruction', a.visibility, a.instructions, '{"kind":"empty"}'::jsonb,
  a.instructions_bundle, a.owner, a.owner, a.owner, a.created_at, timezone('UTC',statement_timestamp())
FROM staff_copy_agents a JOIN staff_copy_target t ON t.org_id = a.org_id
ON CONFLICT (id) DO NOTHING;

-- An intentionally saved empty personal value is a saved value, not a missing row.
INSERT INTO instructions (org_id, user_id, content, bundle)
SELECT t.org_id, m.user_id, t.instructions, t.instructions_bundle
FROM staff_copy_target t JOIN org_members_cache m ON m.org_id = t.org_id
ON CONFLICT (org_id, user_id) DO NOTHING;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM staff_copy_workflows s LEFT JOIN workflows c ON c.id = s.copy_id
    WHERE c.id IS NULL OR c.org_id <> s.org_id OR c.agent_id <> s.target_agent_id
      OR c.name <> s.copy_name OR c.owner_user_id <> s.copy_owner OR c.visibility <> s.copy_visibility
      OR c.instruction IS DISTINCT FROM s.instruction OR c.content_bundle IS DISTINCT FROM s.content_bundle
      OR c.attachments IS DISTINCT FROM s.attachments) THEN
    RAISE EXCEPTION 'Staff Workflow copy identity collision or incomplete publication';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_copy_agents a JOIN staff_copy_target t ON t.org_id=a.org_id
    LEFT JOIN workflows c ON c.id = pg_temp.staff_copy_uuid('staff-single-agent-instruction-v1:' || a.id::text)
    WHERE c.id IS NULL OR c.org_id <> a.org_id OR c.agent_id <> t.target_agent_id
      OR c.name <> a.prefix || '--instruction' OR c.instruction IS DISTINCT FROM a.instructions
      OR c.content_bundle IS DISTINCT FROM a.instructions_bundle
      OR c.owner_user_id <> a.owner OR c.visibility <> a.visibility) THEN
    RAISE EXCEPTION 'Staff Instruction Workflow collision or incomplete publication';
  END IF;
END $$;

-- The previously approved invalid private-Agent/non-owner associations are removed.
-- Normal FK actions retain historical Runs and their Chat identities.
DELETE FROM workflow_user_automation_threads b USING staff_copy_workflows s
WHERE b.workflow_id=s.id AND b.org_id=s.org_id AND s.source_agent_visibility='private'
  AND b.user_id<>s.source_agent_owner;
DELETE FROM workflow_automations a USING staff_copy_workflows s
WHERE a.workflow_id=s.id AND a.org_id=s.org_id AND s.source_agent_visibility='private'
  AND a.owner_user_id<>s.source_agent_owner;

-- Keep exactly one schedule/listener identity. Trigger/config/state columns are untouched.
UPDATE workflow_automations a SET workflow_id=s.copy_id
FROM staff_copy_workflows s WHERE a.workflow_id=s.id AND a.org_id=s.org_id;
UPDATE workflow_user_automation_threads b SET workflow_id=s.copy_id
FROM staff_copy_workflows s WHERE b.workflow_id=s.id AND b.org_id=s.org_id;

-- Snapshot only routing identities. UPDATE below preserves concurrent Chat content,
-- activity, title, native sessions, ownership and all external/provider references.
CREATE TEMP TABLE staff_copy_chat_routes ON COMMIT DROP AS
SELECT c.id, c.user_id, c.agent_id AS source_agent_id,
  pg_temp.staff_copy_uuid('staff-single-agent-project-v1:' || a.org_id || ':' || c.user_id || ':' || a.id::text) AS project_id,
  CASE WHEN a.label_count > 1 OR EXISTS (SELECT 1 FROM projects p
    WHERE p.org_id=a.org_id AND p.user_id=c.user_id AND p.name=a.project_label)
    THEN a.project_label || ' (' || left(a.id::text,8) || ')' ELSE a.project_label END AS project_name,
  a.org_id, t.target_agent_id
FROM chat_threads c JOIN staff_copy_agents a ON c.agent_id=a.id
JOIN staff_copy_target t ON t.org_id=a.org_id;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM staff_copy_chat_routes WHERE length(btrim(project_name)) NOT BETWEEN 1 AND 120)
    OR EXISTS (SELECT 1 FROM staff_copy_chat_routes r JOIN projects p
      ON p.org_id=r.org_id AND p.user_id=r.user_id AND p.name=r.project_name AND p.id<>r.project_id) THEN
    RAISE EXCEPTION 'Staff target Project name changed or collides; refresh the migration census';
  END IF;
END $$;

WITH inserted AS (
  INSERT INTO projects (id,user_id,org_id,name)
  SELECT DISTINCT project_id,user_id,org_id,project_name FROM staff_copy_chat_routes
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
  IF EXISTS (SELECT 1 FROM staff_copy_chat_routes r LEFT JOIN projects p ON p.id=r.project_id
    WHERE p.id IS NULL OR p.org_id<>r.org_id OR p.user_id<>r.user_id) THEN
    RAISE EXCEPTION 'Staff Project identity belongs to another owner';
  END IF;
END $$;

WITH updated AS (
  UPDATE chat_threads c SET agent_id=r.target_agent_id, project_id=r.project_id,
    updated_at=timezone('UTC',statement_timestamp()) FROM staff_copy_chat_routes r
  WHERE c.id=r.id AND c.user_id=r.user_id AND c.agent_id=r.source_agent_id RETURNING c.*
), counts AS (
  SELECT user_id,2*count(*)::bigint AS total FROM updated GROUP BY user_id
), reserved AS (
  INSERT INTO chat_thread_event_sequences (user_id,org_id,last_seq_id)
  SELECT user_id,'org_3ANttyrbWYJk6JKRSTRLEsbsDLe',total FROM counts
  ON CONFLICT (user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+EXCLUDED.last_seq_id
  RETURNING user_id,last_seq_id
)
INSERT INTO chat_thread_events (id,user_id,org_id,seq_id,chat_thread_id,kind,agent_id,
  reassigned_agent_id,project_id,pin_order,created_at)
SELECT gen_random_uuid(),p.user_id,'org_3ANttyrbWYJk6JKRSTRLEsbsDLe',
  r.last_seq_id-c.total+row_number() OVER (PARTITION BY p.user_id ORDER BY p.id,event.ordinal),
  p.id,CASE WHEN event.ordinal=1 THEN 'project_updated' ELSE 'sort_touched' END::chat_thread_event_kind,
  p.agent_id,CASE WHEN event.ordinal=2 THEN p.agent_id ELSE NULL END,
  CASE WHEN event.ordinal=1 THEN p.project_id ELSE NULL END,
  CASE WHEN event.ordinal=2 THEN p.pin_order ELSE NULL END,
  CASE WHEN event.ordinal=1 THEN p.updated_at ELSE p.last_message_at END
FROM updated p JOIN counts c USING(user_id) JOIN reserved r USING(user_id)
CROSS JOIN (VALUES (1),(2)) event(ordinal);

-- The routing/content publication and the per-member activation share this commit.
-- Existing unrelated switch keys survive; other organizations are not selected.
INSERT INTO user_feature_switches (org_id,user_id,switches)
SELECT t.org_id,m.user_id,'{"singleAgent":true}'::jsonb
FROM staff_copy_target t JOIN org_members_cache m ON m.org_id=t.org_id
ON CONFLICT (org_id,user_id) DO UPDATE SET switches=user_feature_switches.switches || EXCLUDED.switches,
  updated_at=timezone('UTC',statement_timestamp())
WHERE user_feature_switches.switches->'singleAgent' IS DISTINCT FROM 'true'::jsonb;

DROP FUNCTION pg_temp.staff_copy_uuid(text);
