-- Reviewed 30-day active multi-Agent rollout following the inactive copy.
-- Exact cohort and resource fingerprints defer changed workspaces without replacement.
-- Reuse the existing attachment-compatible copy identities and Chat/Project events.
-- Append only activated members to the existing My Okou Guide revision.
SET LOCAL TIME ZONE 'UTC';
--> statement-breakpoint
CREATE FUNCTION pg_temp.inactive_batch_uuid(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT overlay(overlay(md5(value) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$fn$;
--> statement-breakpoint
CREATE TEMP TABLE inactive_batch_cohort ON COMMIT DROP AS
WITH frozen AS (
  SELECT value->>0 AS scope_key, value->>1 AS inventory_key
  FROM jsonb_array_elements($cohort$
[["0005e93e411fa803fb528f6402400a997d0bc7a8edc7956e1b9aa435deec44e2","38f0ebf9b265e6b22cf1aa8f3f395dadb27cdbb2d879f0c46636195a35712a8b"],["0f1d7c83916862773357f6abe6f9845083a33bf8152f9411ffb6480d4b67d80c","01a75fa005990bbe40308eeadad2be9fc46ab47fa09e63edebd3e5146aedd5ff"],["1a9a4ecf077210d46b311f124e3116a01959c3c29ce1cf9ed7e8e0d55052d8a9","8591b610dcb8e85bafc177b8aaa5c5cebf209ce872eddd29ac1686cda2239ecb"],["1d326f0cd354202b5570f11620b661103b3d81b82907b423cac8f1402a3ab81f","979ba9a9c940c265c8ef598684f068d56397e255d9cbf6c055ab406c1b0c6dcf"],["399717142aef476a6ca160462e1a96fdfa398584cae23904d710dcd60f8e0c25","ca43dcc859ec328404ace58fd197ab6b814bb4a74a27540b738876e5d77266c6"],["3e590939728592a3b6de0e416ec77630c4f48bb1af9dbb58971b377be0c45fe3","5049894e73cae339546b1f6ede27f059a36fb7ce659b40b9ecb1bf24d5c3a124"],["45126b3236a4d55cf14502897d2d4c242a43030e6edcacec80a7941007db1039","d794cc5bf5166c8f6469affd5571f5c986b655112418dee72b7cde7a97841621"],["4ff8376085d75046c9f1ad33fcd469af03c90996baf9ea26aa4220622afd4cdb","20e8513c4f297041d167a8951d491cc9d200b7c277c1bae697a8257de2d203ba"],["518d21a4d26740c07ce3860077317261ead7c400490d5ad7ffbe838b8241e303","e4965df2e7103be51a798dd1946144ebed7c7b6bc151786cd7c32ce2b862c0a9"],["6421048bed82d8b4890c1cbca4a25e967faa249cfbf3b7dd8a1fa17c366ace31","33cbe8bb7be9e9532ec276cd27432188cc8f695599f6847e69eed4e32c942cdd"],["6585ed27d01ddb06aa9b6f35760e15f1b70a79a47893bdee70b3ff4cafbd8ae7","cac245277c723a4c6c231de8d15de13f40dff73fa5fde2d7138add55d4a19cd8"],["67816652e59defe0eb1063410b8ae7070e293c94db5bb9db3cce4c63deaac79a","0fb2a38db8a48a075de125d38a6be650da3ddfa4fce987c3b9bd2a7f4fbb56b5"],["6c314608a2e3b2e58e651dd7d7abfcd30ab713870d5f1e3be22c4632bd0d60fc","1c8567f58fdc816ed380ca4e5cda1695af090d7761894b519f6e3f9ddc88eb51"],["7a343ff7dfadbafe23482596113f713114df4caf32a8d14af3064c4df7e79721","30543920922595597ac86449ece88eff60b93b10f35ea142e40f752ebdb12985"],["813fd1bb75ac95a8dfdacf87feb0af109c322847cdd5a1fb045408dc9ac0f132","45bf3ba6de36c49333b48d1429e9e7ef65a7072b22196a36b5dce96cf3f87b09"],["8328cdc1703ce22385a00e1f4b8ef0d350349b61edb67d34879dae86921dd4e1","ef9ea1cfa895f74e9349db7c075d2b7a0a57fe26b5b1ea3d692b918135bd3e64"],["86f9603a15769da907faea485c21be7aef523e64066e9aa5b28085490bec40d0","37ac252423e1d1ba2edb5e62a65b5e25a37a910012031e2bf21a5281760e5df6"],["8b1b4051fe8dddec323b52bf1a1de392af839ba9e9d0a463dc3f5371118c6024","987267e021e6d49f97ae3249f24b138629fc831089a1dc7dad9d635080636034"],["8b9565c79ba0b62316f75b7d14a7e8c71baf25f698a35dd51c855ab240ad9523","21e0f3f0fd5e7b129ddc03c5fd461a1e9eefaf59812c9a51cc2f1ff86f1543a2"],["9407192daa399f4537410f569039cda493cd7a1e536238d14b06ca44fc7ce4a9","3830bf56d289fa27620fc06ff7089f74af14a9b8d8562fca46315bb06cec6f33"],["a198a5025bab5b84117e2157cd8ddbaf33bf0c644030279ce26a813d95b3457b","252d37099506747e6796b15897ae1f7024eb71db400a137729a987f9fc96f1bf"],["b32e1274bfa6a8e25b3381b45af01f7d786c25ce4c2b2dfc7d6637fa0bc539db","3c94dbc17a70a884a8d16f20333f4122bb906f26336c9f98adcc957e861ffddc"],["b98a7422a317a8e186f960c6069fef526e3a5c9c2d5f7bd6548ea9f88de3ce82","6d6ed8f3cfdba930d6754ea6dafd921f7d3490d5ac904931db95298d92cb5e91"],["ba7b106291e326651a0a80ac8ed9b1665d84981b0bb5f1e1381333b34414106c","fc04fb18634c5a08fc0ca15eda02f19b47b95ba79ea96751c2f282db78d9f3c5"],["c7162d35966a1ae7f1ebe346608de8c8b4c1b90b93a80d4aa2e9aa94dd200f2b","14362dc8763eeb78df396dbad6e76ffd18d3fea36445bd384c002d39a6a6e59f"],["cb49789a8d2b35b7a6d2bb21ba82559ff30a6db1d901a71ed96fd22df289db91","37431c0abfc952c97cf58374d5206cced08352fb85ba40101620180c0f626d5a"],["cc640639071775f0b091bd6b5ea0e249d8a71e4b10bf17909f1da554a0e3f9f4","8726014f6bb427ce118614d3cbe56adb9d28f405116e3076b048e64d251c17e5"],["d0fa16de87d2b99b54027b27d7f1550169ca24e49ac52dffb09529714a3c0cce","1d70879119511419497c03b06f2e6df12d33a7c923b7e41616ac85dc2f402563"],["ed3e5dc72ff87289ae4330185aee94410716f5202da1abf6718a674e8e16787f","d6b18dda1b7c5831e4d1ea76f704ef896a677ed0b9ebdc23597ecfdca1284a6b"],["fabefbf0301e24acd07e49624f0a15161067a30cedf5e898cd3cbd647b2c9195","aa72cbf2e5d4ef420e00e289ba158689ce0439c7cab1f3681047d8f5432de5f7"]]
$cohort$::jsonb)
), identities AS MATERIALIZED (
  SELECT o.org_id,o.default_agent_id,f.inventory_key
  FROM org_metadata o JOIN frozen f
    ON f.scope_key=encode(sha256(convert_to(o.org_id || ':' || o.default_agent_id::text,'UTF8')),'hex')
), legacy_thread_inventory AS MATERIALIZED (
  SELECT a.org_id,array_agg(x.id ORDER BY x.id) AS chats
  FROM identities o JOIN agents a ON a.org_id=o.org_id AND a.id<>o.default_agent_id
  JOIN chat_threads x ON x.agent_id=a.id GROUP BY a.org_id
), snapshots AS (
  SELECT o.*,
    ARRAY(SELECT m.user_id FROM org_members_metadata m WHERE m.org_id=o.org_id ORDER BY m.user_id COLLATE "C") AS members,
    ARRAY(SELECT m.user_id FROM org_members_cache m WHERE m.org_id=o.org_id ORDER BY m.user_id COLLATE "C") AS cached_members,
    ARRAY(SELECT a.id FROM agents a WHERE a.org_id=o.org_id ORDER BY a.id) AS agents,
    ARRAY(SELECT w.id FROM workflows w WHERE w.org_id=o.org_id ORDER BY w.id) AS workflows,
    ARRAY(SELECT a.id FROM workflow_automations a WHERE a.org_id=o.org_id ORDER BY a.id) AS automations,
    coalesce(chat.chats,'{}'::uuid[]) AS chats
  FROM identities o LEFT JOIN legacy_thread_inventory chat USING(org_id)
)
SELECT org_id,default_agent_id,members,cached_members,agents,workflows,automations,chats
FROM snapshots s
WHERE cardinality(agents)>1 AND cardinality(members)>0
  AND s.inventory_key=encode(sha256(convert_to(concat_ws('|',
    array_to_string(members,','),array_to_string(cached_members,','),array_to_string(agents,','),
    array_to_string(workflows,','),array_to_string(automations,','),array_to_string(chats,',')),'UTF8')),'hex');
ALTER TABLE inactive_batch_cohort ADD PRIMARY KEY (org_id);
ANALYZE inactive_batch_cohort;
--> statement-breakpoint
-- Freeze resource identities, not mutable authored content: copy each current
-- canonical package, and preserve every saved personal value, including empty.
CREATE TEMP TABLE inactive_copy_target ON COMMIT DROP AS
WITH member_inventory AS MATERIALIZED (
  SELECT m.org_id,array_agg(m.user_id ORDER BY m.user_id COLLATE "C") AS ids,
    bool_and(f.switches->'singleAgent' IS NOT DISTINCT FROM 'false'::jsonb
      AND f.switches->'featureGuides' IS DISTINCT FROM 'false'::jsonb) AS all_old
  FROM inactive_batch_cohort c JOIN org_members_metadata m ON m.org_id=c.org_id
  LEFT JOIN user_feature_switches f ON f.org_id=m.org_id AND f.user_id=m.user_id GROUP BY m.org_id
), cache_inventory AS MATERIALIZED (
  SELECT m.org_id,array_agg(m.user_id ORDER BY m.user_id COLLATE "C") AS ids
  FROM inactive_batch_cohort c JOIN org_members_cache m ON m.org_id=c.org_id GROUP BY m.org_id
), agent_inventory AS MATERIALIZED (
  SELECT a.org_id,array_agg(a.id ORDER BY a.id) AS ids
  FROM inactive_batch_cohort c JOIN agents a ON a.org_id=c.org_id GROUP BY a.org_id
), workflow_inventory AS MATERIALIZED (
  SELECT w.org_id,array_agg(w.id ORDER BY w.id) AS ids
  FROM inactive_batch_cohort c JOIN workflows w ON w.org_id=c.org_id GROUP BY w.org_id
), automation_inventory AS MATERIALIZED (
  SELECT a.org_id,array_agg(a.id ORDER BY a.id) AS ids
  FROM inactive_batch_cohort c JOIN workflow_automations a ON a.org_id=c.org_id GROUP BY a.org_id
), chat_inventory AS MATERIALIZED (
  SELECT source.org_id,array_agg(x.id ORDER BY x.id) AS ids,
    bool_and(x.project_id IS NULL AND x.user_id=ANY(c.members)
      AND (source.visibility<>'private' OR x.user_id=source.owner)) AS valid_owners
  FROM inactive_batch_cohort c JOIN agents source ON source.org_id=c.org_id AND source.id<>c.default_agent_id
  JOIN chat_threads x ON x.agent_id=source.id GROUP BY source.org_id
)
SELECT c.*, a.instructions, a.instructions_bundle,a.xmin::text || ':' || a.ctid::text AS default_row_version
FROM inactive_batch_cohort c
JOIN org_metadata o ON o.org_id=c.org_id AND o.default_agent_id=c.default_agent_id
JOIN agents a ON a.id=c.default_agent_id AND a.org_id=c.org_id
  AND a.visibility='public' AND a.owner=ANY(c.members)
JOIN member_inventory mi ON mi.org_id=c.org_id
LEFT JOIN cache_inventory ci ON ci.org_id=c.org_id
LEFT JOIN agent_inventory ai ON ai.org_id=c.org_id
LEFT JOIN workflow_inventory wi ON wi.org_id=c.org_id
LEFT JOIN automation_inventory au ON au.org_id=c.org_id
LEFT JOIN chat_inventory ch ON ch.org_id=c.org_id
WHERE cardinality(c.members)>0 AND c.members <@ c.cached_members
  AND a.instructions_bundle IS NOT NULL
  AND mi.ids=c.members AND mi.all_old
  AND coalesce(ci.ids,'{}'::text[])=c.cached_members
  AND coalesce(ai.ids,'{}'::uuid[])=c.agents
  AND coalesce(wi.ids,'{}'::uuid[])=c.workflows
  AND coalesce(au.ids,'{}'::uuid[])=c.automations
  AND coalesce(ch.ids,'{}'::uuid[])=c.chats AND coalesce(ch.valid_owners,true)
  AND NOT EXISTS (SELECT 1 FROM projects x WHERE x.org_id=c.org_id)
  AND NOT EXISTS (SELECT 1 FROM queued_chat_threads x WHERE x.org_id=c.org_id)
  AND NOT EXISTS (SELECT 1 FROM active_agent_runs x WHERE x.org_id=c.org_id)
  AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.org_id=c.org_id
    AND r.created_at>=greatest(timestamp '2026-10-20 02:54:43.025078',now() AT TIME ZONE 'UTC'-interval '30 days')
    AND r.created_at<timestamp '2026-11-19 02:54:43.025078')
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.org_id=c.org_id AND r.status IN ('pending','running'))
  AND NOT EXISTS (SELECT 1 FROM agents source WHERE source.org_id=c.org_id
    AND (source.owner<>ALL(c.members) OR source.instructions_bundle IS NULL OR source.visibility NOT IN ('public','private')))
  AND NOT EXISTS (SELECT 1 FROM workflows w JOIN agents source ON source.id=w.agent_id
    WHERE w.org_id=c.org_id AND (source.org_id<>c.org_id OR w.owner_user_id<>ALL(c.cached_members)
      OR (source.id<>c.default_agent_id AND (w.official_definition_name IS NOT NULL
        OR w.instruction IS NULL OR w.content_bundle IS NULL OR w.attachments IS NULL
        OR w.owner_user_id<>ALL(c.members) OR w.visibility NOT IN ('public','private')
        OR (source.visibility='private' AND w.owner_user_id<>source.owner)))))
  AND NOT EXISTS (SELECT 1 FROM workflow_automations x JOIN workflows w ON w.id=x.workflow_id
    JOIN agents source ON source.id=w.agent_id WHERE x.org_id=c.org_id
      AND (x.enabled OR w.org_id<>c.org_id OR x.owner_user_id<>ALL(c.cached_members)
        OR (source.id<>c.default_agent_id AND (x.owner_user_id<>ALL(c.members)
          OR (source.visibility='private' AND x.owner_user_id<>source.owner)))))
  AND NOT EXISTS (SELECT 1 FROM workflow_user_automation_threads b JOIN workflows w ON w.id=b.workflow_id
    JOIN agents source ON source.id=w.agent_id
    LEFT JOIN chat_threads chat ON chat.id=b.chat_thread_id
    LEFT JOIN agents chat_agent ON chat_agent.id=chat.agent_id
    WHERE w.org_id=c.org_id AND source.id<>c.default_agent_id
      AND (b.org_id<>c.org_id OR b.user_id<>ALL(c.members)
        OR (source.visibility='private' AND b.user_id<>source.owner)
        OR (chat.id IS NOT NULL AND (chat.user_id<>b.user_id OR chat_agent.org_id<>c.org_id))));
ALTER TABLE inactive_copy_target ADD PRIMARY KEY (org_id);
ANALYZE inactive_copy_target;
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
FROM workflows w JOIN inactive_copy_agents a ON a.id=w.agent_id AND a.org_id=w.org_id;
CREATE TEMP TABLE inactive_copy_chat_routes ON COMMIT DROP AS
SELECT c.id,c.user_id,c.agent_id AS source_agent_id,a.org_id,a.target_agent_id,
  pg_temp.inactive_batch_uuid('inactive-batch-project-v1:' || a.org_id || ':' || c.user_id || ':' || a.id::text) AS project_id,
  CASE WHEN a.label_count>1 THEN a.project_label || ' (' || left(a.id::text,8) || ')'
    ELSE a.project_label END AS project_name
FROM chat_threads c JOIN inactive_copy_agents a ON a.id=c.agent_id;
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
-- Only the definition association changes. Do not activate, recreate, delete or
-- modify disabled schedules/listeners, their delivery state, or their Chat identity.
UPDATE workflow_automations x SET workflow_id=s.copy_id
FROM inactive_copy_workflows s WHERE x.workflow_id=s.id AND x.org_id=s.org_id;
UPDATE workflow_user_automation_threads b SET workflow_id=s.copy_id
FROM inactive_copy_workflows s WHERE b.workflow_id=s.id AND b.org_id=s.org_id;
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
  IF EXISTS (SELECT 1 FROM inactive_copy_chat_routes r LEFT JOIN chat_threads c ON c.id=r.id
    WHERE c.id IS NULL OR c.user_id<>r.user_id OR c.agent_id<>r.target_agent_id OR c.project_id IS DISTINCT FROM r.project_id)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t JOIN LATERAL
      (SELECT 1 FROM agent_runs r WHERE r.org_id=t.org_id AND r.status IN ('pending','running') LIMIT 1) busy ON true)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t JOIN queued_chat_threads q ON q.org_id=t.org_id)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t JOIN active_agent_runs a ON a.org_id=t.org_id)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t JOIN workflow_automations a ON a.org_id=t.org_id WHERE a.enabled)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t LEFT JOIN org_metadata o ON o.org_id=t.org_id
      LEFT JOIN agents a ON a.id=t.default_agent_id
      LEFT JOIN (SELECT org_id,array_agg(id ORDER BY id) AS ids FROM agents GROUP BY org_id) inventory ON inventory.org_id=t.org_id
      WHERE o.default_agent_id IS DISTINCT FROM t.default_agent_id OR a.id IS NULL
        OR a.xmin::text || ':' || a.ctid::text IS DISTINCT FROM t.default_row_version
        OR inventory.ids IS DISTINCT FROM t.agents)
    OR EXISTS (SELECT 1 FROM inactive_copy_agents s LEFT JOIN agents a ON a.id=s.id
      WHERE a.xmin::text || ':' || a.ctid::text IS DISTINCT FROM s.source_row_version)
    OR EXISTS (SELECT 1 FROM workflows w JOIN inactive_copy_agents a ON a.id=w.agent_id
      LEFT JOIN inactive_copy_workflows s ON s.id=w.id
      WHERE w.xmin::text || ':' || w.ctid::text IS DISTINCT FROM s.source_row_version)
    OR EXISTS (SELECT 1 FROM inactive_copy_workflows s LEFT JOIN workflows w ON w.id=s.id WHERE w.id IS NULL)
    OR EXISTS (
      -- The Chat index starts with user_id. Collect Agent IDs in one pass
      -- to avoid a separate index scan for every legacy Agent.
      WITH chat_agents AS MATERIALIZED (SELECT DISTINCT agent_id FROM chat_threads)
      SELECT 1 FROM chat_agents c JOIN inactive_copy_agents a ON a.id=c.agent_id
    )
    OR EXISTS (SELECT 1 FROM workflow_automations a JOIN inactive_copy_workflows s ON s.id=a.workflow_id)
    OR EXISTS (SELECT 1 FROM workflow_user_automation_threads b JOIN inactive_copy_workflows s ON s.id=b.workflow_id)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t
      LEFT JOIN (SELECT org_id,array_agg(user_id ORDER BY user_id COLLATE "C") AS ids FROM org_members_metadata GROUP BY org_id) m ON m.org_id=t.org_id
      LEFT JOIN (SELECT org_id,array_agg(user_id ORDER BY user_id COLLATE "C") AS ids FROM org_members_cache GROUP BY org_id) c ON c.org_id=t.org_id
      WHERE coalesce(m.ids,'{}'::text[])<>t.members OR coalesce(c.ids,'{}'::text[])<>t.cached_members)
    OR EXISTS (SELECT 1 FROM inactive_copy_target t CROSS JOIN LATERAL unnest(t.members) m(user_id)
      LEFT JOIN user_feature_switches f ON f.org_id=t.org_id AND f.user_id=m.user_id
      WHERE f.switches->'singleAgent' IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'Inactive batch changed during cutover; activation must roll back';
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
      AND f.switches->'featureGuides' IS DISTINCT FROM 'false'::jsonb;
  GET DIAGNOSTICS activated = ROW_COUNT;
  IF activated <> (SELECT coalesce(sum(cardinality(members)),0) FROM inactive_copy_target) THEN
    RAISE EXCEPTION 'Active multi-Agent member state changed during cutover';
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
  IF NOT EXISTS (SELECT 1 FROM inactive_copy_target) THEN
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
    WHERE r.starts_at<=now() AND (r.expires_at IS NULL OR r.expires_at>now())
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
  WHERE NOT coalesce(prior_audience->'orgIds' @> jsonb_build_array(t.org_id),false)
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
  VALUES (edition.id,content_json::jsonb,revision_hash,revision.starts_at,revision.expires_at,'migration:1576')
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
