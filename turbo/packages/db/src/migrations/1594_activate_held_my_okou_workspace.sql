-- Migrate the reviewed workspace after the API admission fix and outgoing request drain.
-- Preserve the departed member's private Workflow, Chats and execution binding in place.
SET LOCAL TIME ZONE 'UTC';
--> statement-breakpoint
CREATE FUNCTION pg_temp.inactive_batch_uuid(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT overlay(overlay(md5(value) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$fn$;
--> statement-breakpoint
CREATE TEMP TABLE inactive_batch_cohort ON COMMIT DROP AS
WITH frozen AS (
  SELECT value->>0 AS scope_key,value->>1 AS inventory_key
  FROM jsonb_array_elements($cohort$[["d3b6fd2f1db552aa552830f65a828b887845142be643a5a748d57ddaaf0c2918","5c997b579bbdbd0ac43d180c26c8d4a8c62a68535b5b76b90fa40c26db4127bf"]]$cohort$::jsonb)
), resolved AS MATERIALIZED (
  SELECT o.org_id,o.default_agent_id,f.inventory_key
  FROM org_metadata o JOIN frozen f
    ON f.scope_key=encode(sha256(convert_to(o.org_id||':'||o.default_agent_id::text,'UTF8')),'hex')
), legacy_chat AS MATERIALIZED (
  SELECT a.org_id,array_agg(c.id ORDER BY c.id) AS chats,
    string_agg(c.id::text||':'||c.agent_id::text||':'||c.user_id,',' ORDER BY c.id) AS associations
  FROM resolved r JOIN agents a ON a.org_id=r.org_id AND a.id<>r.default_agent_id
  JOIN chat_threads c ON c.agent_id=a.id GROUP BY a.org_id
), inventory AS (
  SELECT r.*,
    ARRAY(SELECT m.user_id FROM org_members_metadata m WHERE m.org_id=r.org_id ORDER BY m.user_id COLLATE "C") AS members,
    ARRAY(SELECT m.user_id FROM org_members_cache m WHERE m.org_id=r.org_id ORDER BY m.user_id COLLATE "C") AS cached_members,
    ARRAY(SELECT a.id FROM agents a WHERE a.org_id=r.org_id ORDER BY a.id) AS agents,
    (SELECT string_agg(a.id::text||':'||a.owner||':'||a.visibility,',' ORDER BY a.id)
      FROM agents a WHERE a.org_id=r.org_id) AS agent_associations,
    ARRAY(SELECT w.id FROM workflows w WHERE w.org_id=r.org_id ORDER BY w.id) AS workflows,
    (SELECT string_agg(w.id::text||':'||w.agent_id::text||':'||w.owner_user_id||':'||w.visibility,',' ORDER BY w.id)
      FROM workflows w WHERE w.org_id=r.org_id) AS workflow_associations,
    ARRAY(SELECT a.id FROM workflow_automations a WHERE a.org_id=r.org_id ORDER BY a.id) AS automations,
    (SELECT string_agg(a.id::text||':'||a.workflow_id::text||':'||a.owner_user_id||':'||a.enabled::text||':'||a.kind,',' ORDER BY a.id)
      FROM workflow_automations a WHERE a.org_id=r.org_id) AS automation_associations,
    coalesce(c.chats,'{}'::uuid[]) AS chats,coalesce(c.associations,'') AS chat_associations
  FROM resolved r LEFT JOIN legacy_chat c USING(org_id)
)
SELECT * FROM inventory i
WHERE cardinality(members)=12 AND cached_members=members
  AND inventory_key=encode(sha256(convert_to(concat_ws('|',
    coalesce(array_to_string(members,','),''),
    coalesce(array_to_string(cached_members,','),''),
    coalesce(agent_associations,''),coalesce(workflow_associations,''),
    coalesce(automation_associations,''),chat_associations),'UTF8')),'hex');
ALTER TABLE inactive_batch_cohort ADD PRIMARY KEY (org_id);
ANALYZE inactive_batch_cohort;
--> statement-breakpoint
CREATE TEMP TABLE inactive_copy_target ON COMMIT DROP AS
SELECT c.*,a.instructions,a.instructions_bundle,a.xmin::text||':'||a.ctid::text AS default_row_version
FROM inactive_batch_cohort c
JOIN org_metadata o ON o.org_id=c.org_id AND o.default_agent_id=c.default_agent_id
JOIN agents a ON a.id=c.default_agent_id AND a.org_id=c.org_id
  AND a.visibility='public' AND a.owner=ANY(c.members) AND a.instructions_bundle IS NOT NULL
WHERE NOT EXISTS (
  SELECT 1 FROM unnest(c.members) m(user_id) LEFT JOIN user_feature_switches f
    ON f.org_id=c.org_id AND f.user_id=m.user_id
  WHERE f.switches->'singleAgent' IS DISTINCT FROM 'false'::jsonb
    OR (cardinality(c.agents)>1 AND f.switches->'featureGuides'='false'::jsonb)
)
AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.org_id=c.org_id)
AND NOT EXISTS (SELECT 1 FROM queued_chat_threads q WHERE q.org_id=c.org_id)
AND NOT EXISTS (SELECT 1 FROM active_agent_runs r WHERE r.org_id=c.org_id)
AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.org_id=c.org_id AND r.status IN ('pending','running'))
AND NOT EXISTS (
  SELECT 1 FROM workflow_automations x
  WHERE x.org_id=c.org_id AND x.official_blueprint_key='daily-delivery' AND x.enabled
    AND (SELECT claim.settlement FROM morning_brief_schedule_claims claim
         WHERE claim.automation_id=x.id ORDER BY claim.claim_sequence DESC LIMIT 1)='unsettled'
)
AND NOT EXISTS (
  SELECT 1 FROM agents x
  WHERE x.org_id=c.org_id AND (x.owner<>ALL(c.members) OR x.instructions_bundle IS NULL
    OR x.visibility NOT IN ('public','private'))
)
AND NOT EXISTS (
  SELECT 1 FROM chat_threads x JOIN agents source ON source.id=x.agent_id
  WHERE source.org_id=c.org_id AND source.id<>c.default_agent_id
    AND (x.project_id IS NOT NULL
      OR (x.user_id=ANY(c.members) AND source.visibility='private' AND x.user_id<>source.owner))
)
AND NOT EXISTS (
  SELECT 1 FROM workflows w LEFT JOIN agents source ON source.id=w.agent_id
  WHERE w.org_id=c.org_id AND (source.org_id IS DISTINCT FROM c.org_id
    OR (source.id<>c.default_agent_id AND w.owner_user_id=ANY(c.members)
      AND (w.official_definition_name IS NOT NULL OR w.instruction IS NULL OR w.content_bundle IS NULL
        OR w.attachments IS NULL OR w.visibility NOT IN ('public','private')
        OR (source.visibility='private' AND w.owner_user_id<>source.owner)))
    OR (w.owner_user_id<>ALL(c.members) AND (w.visibility<>'private'
      OR EXISTS (SELECT 1 FROM workflow_automations x WHERE x.workflow_id=w.id)
      OR encode(sha256(convert_to(w.id::text||':'||w.owner_user_id,'UTF8')),'hex')
        <> '30ebdb2eb479fa4f70e3c634f3338f930ea0ab727f7b3d8a7eea3e5cd25be874')))
)
AND NOT EXISTS (
  SELECT 1 FROM workflow_automations x LEFT JOIN workflows w ON w.id=x.workflow_id
  LEFT JOIN agents source ON source.id=w.agent_id
  WHERE x.org_id=c.org_id AND (w.org_id IS DISTINCT FROM c.org_id OR x.owner_user_id<>ALL(c.members)
    OR (source.id<>c.default_agent_id AND (w.owner_user_id<>ALL(c.members)
      OR (source.visibility='private' AND x.owner_user_id<>source.owner)
      OR x.official_blueprint_key IS NOT NULL
      OR (x.enabled AND x.kind='schedule' AND (x.next_run_at IS NULL OR x.next_run_at<=now())))))
)
AND NOT EXISTS (
  SELECT 1 FROM workflow_user_automation_threads b JOIN workflows w ON w.id=b.workflow_id
  JOIN agents source ON source.id=w.agent_id LEFT JOIN chat_threads x ON x.id=b.chat_thread_id
  LEFT JOIN agents chat_agent ON chat_agent.id=x.agent_id
  WHERE w.org_id=c.org_id AND source.id<>c.default_agent_id
    AND (b.org_id<>c.org_id
      OR (w.owner_user_id=ANY(c.members) AND
        (b.user_id<>ALL(c.members) OR (source.visibility='private' AND b.user_id<>source.owner)))
      OR (w.owner_user_id<>ALL(c.members) AND
        (b.user_id<>w.owner_user_id OR w.visibility<>'private' OR x.id IS NULL
          OR EXISTS (SELECT 1 FROM workflow_automations watcher
            WHERE watcher.org_id=c.org_id AND watcher.enabled
              AND watcher.event_type='chat-run-finished' AND watcher.event_config->>'chatThreadId'=x.id::text)))
      OR (b.chat_thread_id IS NOT NULL AND
        (x.id IS NULL OR x.user_id<>b.user_id OR chat_agent.org_id<>c.org_id OR x.agent_id<>w.agent_id)))
);
ALTER TABLE inactive_copy_target ADD PRIMARY KEY (org_id);
ANALYZE inactive_copy_target;
--> statement-breakpoint
-- Abort before advancing the journal if the identified customer has outstanding overrides
-- but the reviewed inventory or the quiescence checks no longer match.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM org_metadata o
    WHERE encode(sha256(convert_to(o.org_id,'UTF8')),'hex')='d09dae7bfb060ac7bddd72847b34c054a64605df4c1b608da5000b059a0844d1'
      AND NOT EXISTS (SELECT 1 FROM inactive_copy_target t WHERE t.org_id=o.org_id)
      AND (SELECT count(*) FROM org_members_metadata m JOIN user_feature_switches f USING (org_id,user_id)
           WHERE m.org_id=o.org_id AND f.switches->'singleAgent'='true'::jsonb)<>12)
  THEN RAISE EXCEPTION 'Held My Okou workspace inventory or availability changed'; END IF;
END $$;
--> statement-breakpoint
-- Pin the exact trigger and delivery Chat rows through the cutover.
CREATE TEMP TABLE remaining_automation_source ON COMMIT DROP AS
SELECT x.id,x.org_id,x.workflow_id,to_jsonb(x) AS original_row
FROM inactive_copy_target t JOIN workflow_automations x USING(org_id)
ORDER BY x.id FOR NO KEY UPDATE OF x;
CREATE UNIQUE INDEX ON remaining_automation_source(id);
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM inactive_copy_target t
    WHERE t.automation_associations IS DISTINCT FROM (
      SELECT string_agg(x.id::text||':'||x.workflow_id::text||':'||x.owner_user_id||':'||x.enabled::text||':'||x.kind,',' ORDER BY x.id)
      FROM workflow_automations x JOIN remaining_automation_source s ON s.id=x.id
      WHERE x.org_id=t.org_id
    )
  ) THEN
    RAISE EXCEPTION 'Held My Okou trigger association changed before cutover';
  END IF;
END $$;
CREATE TEMP TABLE remaining_automation_thread_source ON COMMIT DROP AS
SELECT b.id,b.org_id,b.workflow_id,to_jsonb(b) AS original_row
FROM inactive_copy_target t JOIN workflow_user_automation_threads b USING(org_id)
ORDER BY b.id FOR NO KEY UPDATE OF b;
CREATE UNIQUE INDEX ON remaining_automation_thread_source(id);
-- The departed member's rows never participate in the copy or Project route map.
CREATE TEMP TABLE held_departed_chats ON COMMIT DROP AS
SELECT c.id, to_jsonb(c) AS original_row FROM inactive_copy_target t
JOIN agents a ON a.org_id=t.org_id AND a.id<>t.default_agent_id
JOIN chat_threads c ON c.agent_id=a.id AND c.user_id<>ALL(t.members)
ORDER BY c.id FOR NO KEY UPDATE OF c;
CREATE TEMP TABLE held_departed_workflow ON COMMIT DROP AS
SELECT w.id, to_jsonb(w) AS original_row FROM inactive_copy_target t
JOIN workflows w ON w.org_id=t.org_id AND w.owner_user_id<>ALL(t.members)
FOR NO KEY UPDATE OF w;
-- Confirm the precise exception, enabled completion watchers, and retained Chat before writing.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_target t WHERE
    (SELECT encode(sha256(convert_to(string_agg(c.id::text||':'||(c.original_row->>'agent_id')||':'||(c.original_row->>'user_id'),',' ORDER BY c.id),'UTF8')),'hex')
     FROM held_departed_chats c) IS DISTINCT FROM '5696a5cda074ba4c862692ed418ddf2b4e9be8e3b4dec1ad0932b031ec695158'
    OR (SELECT count(*) FROM held_departed_workflow)<>1
    OR (SELECT count(*) FROM remaining_automation_thread_source b JOIN held_departed_workflow w ON w.id=b.workflow_id)<>1
    OR (SELECT count(*) FROM remaining_automation_thread_source)<>110
    OR (SELECT count(*) FROM remaining_automation_source)<>59
    OR (SELECT count(*) FROM workflow_automations x JOIN agents a ON a.org_id=t.org_id
        JOIN chat_threads c ON c.agent_id=a.id AND c.id::text=x.event_config->>'chatThreadId'
        WHERE x.org_id=t.org_id AND x.enabled AND x.event_type='chat-run-finished'
          AND c.user_id=x.owner_user_id AND c.user_id=ANY(t.members))<>2
    OR EXISTS (SELECT 1 FROM held_departed_chats d JOIN workflow_automations x
        ON x.org_id=t.org_id AND x.enabled AND x.event_type='chat-run-finished'
          AND x.event_config->>'chatThreadId'=d.id::text))
  THEN RAISE EXCEPTION 'Held My Okou ownership or completion watcher changed'; END IF;
END $$;
--> statement-breakpoint
-- Canonical Agent slugs supply the same bounded prefix namespace as the staff
-- planner. Project labels retain the authored display name, including non-ASCII.
CREATE TEMP TABLE inactive_copy_agents ON COMMIT DROP AS
WITH named AS (
  SELECT a.*, a.xmin::text || ':' || a.ctid::text AS source_row_version,t.default_agent_id AS target_agent_id,
    coalesce(nullif(btrim(a.display_name),''),a.name) AS project_label,
    coalesce(nullif(rtrim(left(trim(both '-' from regexp_replace(lower(a.name),'[^a-z0-9]+','-','g')),12),'-'),''),
      'a-' || left(replace(a.id::text,'-',''),8)) AS proposed_prefix
  FROM agents a JOIN inactive_copy_target t ON t.org_id=a.org_id AND a.id<>t.default_agent_id
), ranked AS (
  SELECT named.*, count(*) OVER (PARTITION BY org_id,proposed_prefix) AS prefix_count,
    count(*) OVER (PARTITION BY org_id,lower(project_label)) AS label_count FROM named
)
SELECT ranked.*, CASE WHEN prefix_count>1
  THEN rtrim(left(proposed_prefix,3),'-') || '-' || left(replace(id::text,'-',''),8)
  ELSE proposed_prefix END AS prefix FROM ranked;
CREATE TEMP TABLE inactive_copy_workflows ON COMMIT DROP AS
SELECT w.*, w.xmin::text || ':' || w.ctid::text AS source_row_version,
  pg_temp.inactive_batch_uuid('inactive-batch-workflow-v1:' || w.id::text) AS copy_id,
  a.target_agent_id, a.visibility AS source_agent_visibility, a.owner AS source_agent_owner,
  CASE WHEN a.visibility='private' THEN 'private' ELSE w.visibility END AS copy_visibility,
  CASE WHEN length(a.prefix || '--wf-' || w.name)<=64 THEN a.prefix || '--wf-' || w.name
    ELSE a.prefix || '--wf-' || rtrim(left(w.name,64-length(a.prefix)-5-9),'-') || '-' ||
      left(encode(sha256(convert_to('["' || a.id::text || '","' || w.name || '"]','UTF8')),'hex'),8)
  END AS copy_name
FROM workflows w JOIN inactive_copy_agents a ON a.id=w.agent_id AND a.org_id=w.org_id
JOIN inactive_copy_target t ON t.org_id=w.org_id AND w.owner_user_id=ANY(t.members);
CREATE TEMP TABLE inactive_copy_chat_routes ON COMMIT DROP AS
SELECT c.id,c.user_id,c.agent_id AS source_agent_id,a.org_id,a.target_agent_id,
  pg_temp.inactive_batch_uuid('inactive-batch-project-v1:' || a.org_id || ':' || c.user_id || ':' || a.id::text) AS project_id,
  CASE WHEN a.label_count>1 THEN a.project_label || ' (' || left(a.id::text,8) || ')'
    ELSE a.project_label END AS project_name
FROM chat_threads c JOIN inactive_copy_agents a ON a.id=c.agent_id
JOIN inactive_copy_target t ON t.org_id=a.org_id AND c.user_id=ANY(t.members);
ANALYZE inactive_copy_agents;
ANALYZE inactive_copy_workflows;
ANALYZE inactive_copy_chat_routes;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_agents WHERE prefix !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(prefix)>12)
    OR EXISTS (SELECT 1 FROM inactive_copy_agents GROUP BY org_id,prefix HAVING count(*)>1)
    OR EXISTS (SELECT 1 FROM inactive_copy_workflows WHERE copy_name !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$')
    OR EXISTS (SELECT 1 FROM inactive_copy_chat_routes WHERE length(btrim(project_name)) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'Inactive batch target names require review';
  END IF;
  IF EXISTS (SELECT 1 FROM inactive_copy_workflows s JOIN workflows w
    ON w.org_id=s.org_id AND w.agent_id=s.target_agent_id AND w.name=s.copy_name)
    OR EXISTS (SELECT 1 FROM inactive_copy_agents a JOIN workflows w
      ON w.org_id=a.org_id AND w.agent_id=a.target_agent_id AND w.name=a.prefix || '--instruction') THEN
    RAISE EXCEPTION 'Inactive batch target Workflow namespace collision';
  END IF;
END $$;
--> statement-breakpoint
-- Source definitions remain available to historical Runs. Copies share immutable
-- descriptors and preserve authored content, attachments, ownership and attribution.
INSERT INTO workflows (id,org_id,agent_id,name,visibility,instruction,attachments,content_bundle,
  owner_user_id,display_name,description,official_definition_name,official_installation_state,
  import_source,import_session_id,created_by,updated_by,created_at,updated_at)
SELECT copy_id,org_id,target_agent_id,copy_name,copy_visibility,instruction,attachments,content_bundle,
  owner_user_id,display_name,description,NULL,NULL,import_source,import_session_id,
  created_by,updated_by,created_at,now()
FROM inactive_copy_workflows ON CONFLICT (id) DO NOTHING;
INSERT INTO workflows (id,org_id,agent_id,name,visibility,instruction,attachments,content_bundle,
  owner_user_id,created_by,updated_by,created_at,updated_at)
SELECT pg_temp.inactive_batch_uuid('inactive-batch-instruction-v1:' || a.id::text),
  a.org_id,a.target_agent_id,a.prefix || '--instruction',a.visibility,a.instructions,
  '{"kind":"empty"}'::jsonb,a.instructions_bundle,a.owner,a.owner,a.owner,a.created_at,now()
FROM inactive_copy_agents a ON CONFLICT (id) DO NOTHING;
INSERT INTO instructions (org_id,user_id,content,bundle)
SELECT t.org_id,m.user_id,t.instructions,t.instructions_bundle
FROM inactive_copy_target t CROSS JOIN LATERAL unnest(t.members) AS m(user_id)
ON CONFLICT (org_id,user_id) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_workflows s LEFT JOIN workflows w ON w.id=s.copy_id
    WHERE w.id IS NULL OR w.org_id<>s.org_id OR w.agent_id<>s.target_agent_id
      OR w.name<>s.copy_name OR w.owner_user_id<>s.owner_user_id OR w.visibility<>s.copy_visibility
      OR w.instruction IS DISTINCT FROM s.instruction OR w.attachments IS DISTINCT FROM s.attachments
      OR w.content_bundle IS DISTINCT FROM s.content_bundle
      OR w.display_name IS DISTINCT FROM s.display_name OR w.description IS DISTINCT FROM s.description
      OR w.import_source IS DISTINCT FROM s.import_source OR w.import_session_id IS DISTINCT FROM s.import_session_id
      OR w.created_by<>s.created_by OR w.updated_by<>s.updated_by OR w.created_at<>s.created_at
      OR w.official_definition_name IS NOT NULL OR w.official_installation_state IS NOT NULL)
    OR EXISTS (SELECT 1 FROM inactive_copy_agents a LEFT JOIN workflows w
      ON w.id=pg_temp.inactive_batch_uuid('inactive-batch-instruction-v1:' || a.id::text)
      WHERE w.id IS NULL OR w.org_id<>a.org_id OR w.agent_id<>a.target_agent_id
        OR w.name<>a.prefix || '--instruction' OR w.owner_user_id<>a.owner OR w.visibility<>a.visibility
        OR w.instruction IS DISTINCT FROM a.instructions OR w.content_bundle IS DISTINCT FROM a.instructions_bundle
        OR w.attachments IS DISTINCT FROM '{"kind":"empty"}'::jsonb) THEN
    RAISE EXCEPTION 'Inactive batch Workflow copy identity collision';
  END IF;
END $$;
--> statement-breakpoint
-- Keep existing trigger and Chat-binding identities and modify only the definition association.
UPDATE workflow_automations x SET workflow_id=s.copy_id
FROM remaining_automation_source original JOIN inactive_copy_workflows s ON s.id=original.workflow_id
WHERE x.id=original.id AND x.org_id=original.org_id AND to_jsonb(x)=original.original_row;
UPDATE workflow_user_automation_threads b SET workflow_id=s.copy_id
FROM remaining_automation_thread_source original JOIN inactive_copy_workflows s ON s.id=original.workflow_id
WHERE b.id=original.id AND b.org_id=original.org_id AND to_jsonb(b)=original.original_row;
--> statement-breakpoint
WITH groups AS (
  SELECT DISTINCT project_id,user_id,org_id,project_name FROM inactive_copy_chat_routes
), inserted AS (
  INSERT INTO projects (id,user_id,org_id,name,sort_order)
  SELECT project_id,user_id,org_id,project_name,
    'a0' || lpad(row_number() OVER (PARTITION BY user_id,org_id ORDER BY project_id)::text,17,'0') || '1'
  FROM groups ON CONFLICT (id) DO NOTHING RETURNING *
), counts AS (
  SELECT user_id,org_id,count(*)::bigint AS total FROM inserted GROUP BY user_id,org_id
), reserved AS (
  INSERT INTO project_event_sequences (user_id,org_id,last_seq_id)
  SELECT user_id,org_id,total FROM counts
  ON CONFLICT (user_id,org_id) DO UPDATE SET last_seq_id=project_event_sequences.last_seq_id+EXCLUDED.last_seq_id
  RETURNING user_id,org_id,last_seq_id
)
INSERT INTO project_events (id,user_id,org_id,seq_id,project_id,kind,name,sort_order)
SELECT gen_random_uuid(),p.user_id,p.org_id,
  r.last_seq_id-c.total+row_number() OVER (PARTITION BY p.user_id,p.org_id ORDER BY p.id),
  p.id,'created',p.name,p.sort_order
FROM inserted p JOIN counts c USING(user_id,org_id) JOIN reserved r USING(user_id,org_id);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM inactive_copy_chat_routes r LEFT JOIN projects p ON p.id=r.project_id
    WHERE p.id IS NULL OR p.org_id<>r.org_id OR p.user_id<>r.user_id OR p.name<>r.project_name
      OR p.sort_order IS NULL) THEN
    RAISE EXCEPTION 'Inactive batch Project copy identity collision';
  END IF;
END $$;
--> statement-breakpoint
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
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM inactive_copy_chat_routes r LEFT JOIN chat_threads c ON c.id=r.id
    WHERE c.id IS NULL OR c.user_id<>r.user_id OR c.agent_id<>r.target_agent_id OR c.project_id IS DISTINCT FROM r.project_id
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN queued_chat_threads q USING(org_id)
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN active_agent_runs a USING(org_id)
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN agent_runs r USING(org_id) WHERE r.status IN ('pending','running')
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t LEFT JOIN org_metadata o USING(org_id)
    LEFT JOIN agents a ON a.id=t.default_agent_id
    WHERE o.default_agent_id IS DISTINCT FROM t.default_agent_id OR a.id IS NULL
      OR a.xmin::text||':'||a.ctid::text IS DISTINCT FROM t.default_row_version
      OR ARRAY(SELECT x.id FROM agents x WHERE x.org_id=t.org_id ORDER BY x.id)<>t.agents
      OR ARRAY(SELECT m.user_id FROM org_members_metadata m WHERE m.org_id=t.org_id ORDER BY m.user_id COLLATE "C")<>t.members
      OR ARRAY(SELECT m.user_id FROM org_members_cache m WHERE m.org_id=t.org_id ORDER BY m.user_id COLLATE "C")<>t.cached_members
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_agents s LEFT JOIN agents a ON a.id=s.id
    WHERE a.xmin::text||':'||a.ctid::text IS DISTINCT FROM s.source_row_version
  ) OR EXISTS (
    SELECT 1 FROM workflows w JOIN inactive_copy_agents a ON a.id=w.agent_id
    JOIN inactive_copy_target t ON t.org_id=a.org_id AND w.owner_user_id=ANY(t.members)
    LEFT JOIN inactive_copy_workflows s ON s.id=w.id
    WHERE w.xmin::text||':'||w.ctid::text IS DISTINCT FROM s.source_row_version
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_workflows s LEFT JOIN workflows w ON w.id=s.id WHERE w.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_agents a JOIN inactive_copy_target t ON t.org_id=a.org_id
    JOIN chat_threads x ON x.agent_id=a.id WHERE x.user_id=ANY(t.members)
  ) OR EXISTS (
    SELECT 1 FROM remaining_automation_source original LEFT JOIN workflow_automations x ON x.id=original.id
    LEFT JOIN inactive_copy_workflows s ON s.id=original.workflow_id
    WHERE x.workflow_id IS DISTINCT FROM coalesce(s.copy_id,original.workflow_id)
      OR to_jsonb(x)-'workflow_id' IS DISTINCT FROM original.original_row-'workflow_id'
      OR (s.id IS NOT NULL AND x.enabled AND x.kind='schedule'
        AND (x.next_run_at IS NULL OR x.next_run_at<=clock_timestamp()))
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN workflow_automations x USING(org_id)
    LEFT JOIN remaining_automation_source original ON original.id=x.id WHERE original.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM remaining_automation_thread_source original
    LEFT JOIN workflow_user_automation_threads b ON b.id=original.id
    LEFT JOIN inactive_copy_workflows s ON s.id=original.workflow_id
    WHERE b.workflow_id IS DISTINCT FROM coalesce(s.copy_id,original.workflow_id)
      OR to_jsonb(b)-'workflow_id' IS DISTINCT FROM original.original_row-'workflow_id'
  ) OR EXISTS (
    SELECT 1 FROM workflow_user_automation_threads b JOIN inactive_copy_workflows s ON s.id=b.workflow_id
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target t JOIN workflow_user_automation_threads b USING (org_id)
    LEFT JOIN remaining_automation_thread_source original ON original.id=b.id WHERE original.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM held_departed_chats d LEFT JOIN chat_threads c ON c.id=d.id
    WHERE to_jsonb(c) IS DISTINCT FROM d.original_row
  ) OR EXISTS (
    SELECT 1 FROM held_departed_workflow d LEFT JOIN workflows w ON w.id=d.id
    WHERE to_jsonb(w) IS DISTINCT FROM d.original_row
  ) OR EXISTS (
    SELECT 1 FROM inactive_copy_target WHERE
      (SELECT count(*) FROM inactive_copy_workflows)<>181
      OR (SELECT count(*) FROM inactive_copy_chat_routes)<>514
      OR (SELECT count(DISTINCT project_id) FROM inactive_copy_chat_routes)<>39
      OR (SELECT count(*) FROM remaining_automation_source a JOIN inactive_copy_workflows w ON w.id=a.workflow_id)<>32
      OR (SELECT count(*) FROM remaining_automation_thread_source b JOIN inactive_copy_workflows w ON w.id=b.workflow_id)<>77
  ) THEN
    RAISE EXCEPTION 'Held My Okou source changed during cutover';
  END IF;
END $$;
--> statement-breakpoint
-- Activate the same pairs used by the Guide revision and preserve unrelated switches.
DO $$
DECLARE
  activated integer;
BEGIN
  UPDATE user_feature_switches f
    SET switches=f.switches || '{"singleAgent":true}'::jsonb,updated_at=now()
    FROM inactive_copy_target t
    WHERE f.org_id=t.org_id AND f.user_id=ANY(t.members)
      AND f.switches->'singleAgent'='false'::jsonb
      AND (cardinality(t.agents)=1 OR f.switches->'featureGuides' IS DISTINCT FROM 'false'::jsonb);
  GET DIAGNOSTICS activated = ROW_COUNT;
  IF activated <> (SELECT coalesce(sum(cardinality(members)),0) FROM inactive_copy_target) THEN
    RAISE EXCEPTION 'Held My Okou member state changed during cutover';
  END IF;
END $$;
--> statement-breakpoint
-- Keep the published edition and receipts. Append the successfully migrated
-- member pairs to a new immutable revision without changing edition precedence.
DO $$
DECLARE
  edition feature_guide_editions%ROWTYPE;
  revision feature_guide_revisions%ROWTYPE;
  updated_revision uuid;
  prior_audience jsonb;
  users jsonb;
  new_users jsonb;
  audience_json text;
  orgs_json text;
  users_json text;
  content_json text;
  revision_hash text;
  approved_content constant text := $guide${"schemaVersion":1,"title":"My Okou","description":"One Okou, personal Instructions, reusable Workflows.","items":[{"featureId":"my-okou","featureSwitch":"singleAgent","title":"One Okou. Your subagents, now projects","description":"Start any task with your own Okou. Your former subagents are now projects, organized in the chat sidebar.","media":{"type":"illustration","alt":"Illustrated example: Okou beside Writing and Research project cards in Chat → Projects, with Market overview and Customer insights conversations.","characterUrl":"https://static.okou.io/platform/feature-guides/my-okou/okou-multitask-356bc36cc3.webp","scene":{"type":"projects","location":["Chat","Projects"],"title":"Research","subtitle":"Project","backTitle":"Writing","conversations":["Market overview","Customer insights"]}}},{"featureId":"personal-instructions","featureSwitch":"singleAgent","title":"Your instructions are now in Settings","description":"Find and edit your Okou's instructions in Settings → Personal → My Okou.","media":{"type":"illustration","alt":"Illustrated example: Okou beside the personal instructions editor in Settings → Personal → My Okou, with a selected line and formatting toolbar.","characterUrl":"https://static.okou.io/platform/feature-guides/my-okou/okou-instructions-3c85f9896b.webp","scene":{"type":"instructions","location":["Settings","Personal","My Okou"],"title":"My Okou","subtitle":"Personal instructions","lines":["Keep answers concise.","Use clear headings.","End with next steps."]}}},{"featureId":"workspace-workflows","featureSwitch":"singleAgent","title":"Your workflows, in one place","description":"Keep repeatable task steps in Workflows. Use them yourself or share them with your workspace.","media":{"type":"illustration","alt":"Illustrated example: Okou carrying a folder beside a shared Research brief and a private Weekly report workflow with reusable steps.","characterUrl":"https://static.okou.io/platform/feature-guides/my-okou/okou-workflows-5842643b2b.webp","scene":{"type":"workflows","location":["Workflows"],"title":"Weekly report","subtitle":"Reusable instructions","steps":["Review the week","Summarize progress","Outline next steps"],"command":"/weekly-report","privateLabel":"Private","backTitle":"Research brief","backCommand":"/research-brief","sharedLabel":"Shared"}}}]}$guide$;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inactive_copy_target WHERE cardinality(agents)>1) THEN
    RETURN;
  END IF;

  SELECT e.* INTO edition FROM feature_guide_editions e
    WHERE e.id='single-agent-2026-11-16' FOR NO KEY UPDATE;
  SELECT r.* INTO revision FROM feature_guide_revisions r
    WHERE r.edition_id=edition.id AND r.id=edition.published_revision_id;
  IF edition.published_at IS NULL OR revision.id IS NULL OR revision.starts_at>now()
    OR (revision.expires_at IS NOT NULL AND revision.expires_at<=now())
    OR revision.content-'audience' IS DISTINCT FROM approved_content::jsonb THEN
    RAISE EXCEPTION 'Published My Okou Guide requires revalidation before cutover';
  END IF;

  -- Publishing an audience delta must not replace another edition that the
  -- current Guide selector prefers for a member who has yet to see My Okou.
  IF EXISTS (
    SELECT 1 FROM inactive_copy_target t CROSS JOIN LATERAL unnest(t.members) m(user_id)
    JOIN feature_guide_editions e ON (e.published_at,e.id)>(edition.published_at,edition.id)
    JOIN feature_guide_revisions r ON r.id=e.published_revision_id AND r.edition_id=e.id
    WHERE cardinality(t.agents)>1 AND r.starts_at<=now() AND (r.expires_at IS NULL OR r.expires_at>now())
      AND (r.content->'audience' IS NULL
        OR r.content->'audience'->'orgIds' @> jsonb_build_array(t.org_id)
        OR r.content->'audience'->'users' @> jsonb_build_array(jsonb_build_object('orgId',t.org_id,'userId',m.user_id)))
      AND NOT EXISTS (SELECT 1 FROM feature_guide_receipts seen WHERE seen.edition_id=edition.id AND seen.user_id=m.user_id)
  ) THEN
    RAISE EXCEPTION 'A newer Guide takes precedence for a cutover member';
  END IF;

  prior_audience := revision.content->'audience';
  -- An unrestricted edition already covers every cutover member.
  IF prior_audience IS NULL THEN
    RETURN;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('orgId',t.org_id,'userId',m.user_id) ORDER BY t.org_id,m.user_id)
    INTO new_users
  FROM inactive_copy_target t CROSS JOIN LATERAL unnest(t.members) m(user_id)
  WHERE cardinality(t.agents)>1
    AND NOT coalesce(prior_audience->'orgIds' @> jsonb_build_array(t.org_id),false)
    AND NOT coalesce(prior_audience->'users' @> jsonb_build_array(jsonb_build_object('orgId',t.org_id,'userId',m.user_id)),false);
  IF new_users IS NULL THEN
    RETURN;
  END IF;

  users := coalesce(prior_audience->'users','[]'::jsonb) || new_users;
  IF jsonb_array_length(users)>1000 THEN
    RAISE EXCEPTION 'My Okou Guide audience exceeds the supported limit';
  END IF;

  -- Match the existing import service's JSON.stringify field order and ISO
  -- timestamps so re-importing this exact revision resolves to the same row.
  SELECT string_agg(to_json(value)::text,',' ORDER BY ordinal) INTO orgs_json
    FROM jsonb_array_elements_text(prior_audience->'orgIds') WITH ORDINALITY AS org(value,ordinal);
  SELECT string_agg('{"orgId":'||to_json(value->>'orgId')::text||',"userId":'||to_json(value->>'userId')::text||'}',
      ',' ORDER BY ordinal) INTO users_json
    FROM jsonb_array_elements(users) WITH ORDINALITY AS member(value,ordinal);
  audience_json := '{'||coalesce('"orgIds":['||orgs_json||'],','')||'"users":['||users_json||']}';
  content_json := left(approved_content,-1)||',"audience":'||audience_json||'}';
  revision_hash := encode(sha256(convert_to(
    '{"editionId":'||to_json(edition.id)::text||',"content":'||content_json
    ||',"startsAt":'||to_json(to_char(revision.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    ||',"expiresAt":'||coalesce(to_json(to_char(revision.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,'null')||'}',
    'UTF8')),'hex');

  INSERT INTO feature_guide_revisions (edition_id,content,content_hash,starts_at,expires_at,created_by)
  VALUES (edition.id,content_json::jsonb,revision_hash,revision.starts_at,revision.expires_at,'migration:1594')
  ON CONFLICT (edition_id,content_hash) DO NOTHING;

  SELECT id INTO updated_revision FROM feature_guide_revisions
    WHERE edition_id=edition.id AND content_hash=revision_hash
      AND content=content_json::jsonb AND starts_at=revision.starts_at
      AND expires_at IS NOT DISTINCT FROM revision.expires_at;
  IF updated_revision IS NULL THEN
    RAISE EXCEPTION 'My Okou Guide revision hash collision';
  END IF;
  UPDATE feature_guide_editions SET published_revision_id=updated_revision WHERE id=edition.id;
END $$;
--> statement-breakpoint
DROP FUNCTION pg_temp.inactive_batch_uuid(text);
