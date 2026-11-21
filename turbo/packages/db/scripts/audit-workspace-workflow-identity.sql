-- Run against the pre-1611 schema. Rows identify migration blockers without
-- printing Workflow names or content. Each array lists all affected Workflow IDs.
WITH projected AS (
  SELECT w.*, a.org_id AS agent_org_id, a.owner AS agent_owner,
    a.visibility = 'private' AS private_executor,
    CASE WHEN a.visibility = 'private' THEN 'private' ELSE w.visibility END AS effective_visibility
  FROM workflows w JOIN agents a ON a.id = w.agent_id
), workflow_issues AS (
SELECT 'foreign_workspace' AS problem, org_id, ARRAY[id] AS workflow_ids
FROM projected WHERE org_id <> agent_org_id
UNION ALL
SELECT 'two_private_readers', org_id, ARRAY[id] FROM projected
WHERE visibility = 'public' AND private_executor AND owner_user_id <> agent_owner
UNION ALL
SELECT 'public_name', org_id, array_agg(id ORDER BY id) FROM projected
WHERE effective_visibility = 'public' GROUP BY org_id, name HAVING count(*) > 1
UNION ALL
SELECT 'private_name', org_id, array_agg(id ORDER BY id) FROM projected
WHERE effective_visibility = 'private' AND official_definition_name IS NULL
GROUP BY org_id, owner_user_id, name HAVING count(*) > 1
UNION ALL
SELECT 'official_installation', org_id, array_agg(id ORDER BY id) FROM projected
WHERE official_definition_name IS NOT NULL
GROUP BY org_id, owner_user_id, official_definition_name HAVING count(*) > 1
UNION ALL
SELECT 'morning_brief', org_id, array_agg(id ORDER BY id) FROM projected
WHERE official_definition_name IN ('morning-brief', 'internal-test-morning-brief')
GROUP BY org_id, owner_user_id HAVING count(*) > 1
), shared_profiles AS (
  SELECT org_id, id FROM agents WHERE name = 'default-agent' AND visibility = 'public'
)
SELECT problem, org_id, workflow_ids, NULL::uuid AS previous_executor, NULL::uuid AS shared_executor
FROM workflow_issues
UNION ALL
SELECT 'default_executor', coalesce(m.org_id, a.org_id), ARRAY[]::uuid[], m.default_agent_id, a.id
FROM org_metadata m FULL JOIN shared_profiles a ON a.org_id = m.org_id
WHERE m.default_agent_id IS DISTINCT FROM a.id
ORDER BY 1, 2, 3;
