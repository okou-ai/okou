-- Run against the pre-1611 schema. Rows identify migration blockers without
-- printing Workflow names or content. Each array lists all affected Workflow IDs.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH projected AS (
  SELECT w.*, a.org_id AS agent_org_id, a.owner AS agent_owner,
    a.visibility = 'private' AS private_executor,
    CASE WHEN a.visibility = 'private' THEN 'private' ELSE w.visibility END AS effective_visibility
  FROM workflows w JOIN agents a ON a.id = w.agent_id
)
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
ORDER BY 1, 2, 3;

SELECT m.org_id, m.default_agent_id AS previous_executor, a.id AS shared_executor
FROM org_metadata m LEFT JOIN agents a ON a.org_id = m.org_id
  AND a.name = 'default-agent' AND a.visibility = 'public'
WHERE m.default_agent_id IS DISTINCT FROM a.id ORDER BY m.org_id;

COMMIT;
