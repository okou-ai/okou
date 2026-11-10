import postgres from "postgres";
import { parseSnapshot, PlanningError } from "./snapshot";

/** One statement gives every selected table the same MVCC read snapshot. */
export async function inventory(
  connection: string,
  orgId: string,
  target: string,
) {
  const db = postgres(connection, {
    max: 1,
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: true,
      statement_timeout: 60_000,
    },
    onnotice: () => {},
  });
  try {
    const rows = await db`
      WITH selected_agents AS MATERIALIZED (
        SELECT id FROM agents WHERE org_id = ${orgId}
      )
      SELECT jsonb_build_object(
        'format', 'single-agent-inventory-v1', 'target', ${target}::text,
        'orgId', ${orgId}::text, 'database', current_database(),
        'capturedAt', statement_timestamp(),
        'readOnly', current_setting('transaction_read_only') = 'on',
        'defaultAgentId', o.default_agent_id,
        'members', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'role', m.role) ORDER BY m.user_id), '[]'::jsonb)
          FROM org_members_cache m WHERE m.org_id = o.org_id),
        'agents', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', a.id, 'name', a.name, 'displayName', a.display_name,
          'owner', a.owner, 'visibility', a.visibility, 'revision', a.xmin::text,
          'instructions', jsonb_build_object(
            'hash', encode(sha256(convert_to(a.instructions, 'UTF8')), 'hex'),
            'bytes', octet_length(a.instructions), 'bundle', a.instructions_bundle)
          ) ORDER BY a.id), '[]'::jsonb) FROM agents a WHERE a.org_id = o.org_id),
        'personalInstructions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'userId', i.user_id, 'version', i.version, 'revision', i.xmin::text,
          'content', jsonb_build_object(
            'hash', encode(sha256(convert_to(i.content, 'UTF8')), 'hex'),
            'bytes', octet_length(i.content), 'bundle', i.bundle)
          ) ORDER BY i.user_id), '[]'::jsonb) FROM instructions i WHERE i.org_id = o.org_id),
        'workflows', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', w.id, 'agentId', w.agent_id, 'name', w.name,
          'owner', w.owner_user_id, 'visibility', w.visibility,
          'revision', w.xmin::text, 'official', w.official_definition_name,
          'officialState', w.official_installation_state,
          'bundle', w.content_bundle) ORDER BY w.id), '[]'::jsonb)
          FROM workflows w WHERE w.org_id = o.org_id),
        'automations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', a.id, 'workflowId', a.workflow_id, 'owner', a.owner_user_id,
          'enabled', a.enabled, 'kind', a.kind, 'revision', a.xmin::text,
          'fingerprint', encode(sha256(convert_to(to_jsonb(a)::text, 'UTF8')), 'hex')
          ) ORDER BY a.id), '[]'::jsonb) FROM workflow_automations a WHERE a.org_id = o.org_id),
        'automationThreads', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', t.id, 'workflowId', t.workflow_id, 'owner', t.user_id,
          'chatThreadId', t.chat_thread_id, 'revision', t.xmin::text
          ) ORDER BY t.id), '[]'::jsonb) FROM workflow_user_automation_threads t WHERE t.org_id = o.org_id),
        'chats', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id, 'agentId', c.agent_id, 'owner', c.user_id,
          'projectId', c.project_id, 'revision', c.xmin::text) ORDER BY c.id), '[]'::jsonb)
          FROM chat_threads c JOIN selected_agents a ON a.id = c.agent_id),
        'projects', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'owner', p.user_id, 'name', p.name, 'revision', p.xmin::text)
          ORDER BY p.id), '[]'::jsonb) FROM projects p WHERE p.org_id = o.org_id)
      ) AS snapshot FROM org_metadata o WHERE o.org_id = ${orgId}
    `;
    if (rows.length !== 1) throw new PlanningError("OrganizationNotFound");
    return parseSnapshot(rows[0]?.snapshot);
  } finally {
    await db.end();
  }
}
