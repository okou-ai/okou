import assert from "node:assert/strict";
import type postgres from "postgres";

// Release-infrastructure verification shared by local fixtures and the disposable
// Neon rehearsal. Raw authored rows remain in session-local temporary tables.
// In an isolated copy, xmin/ctid detects every rewrite of untouched rows without
// fetching large TOAST bodies. Do not VACUUM FULL/CLUSTER between these checks.
const unchanged = [
  ["agents", "id"],
  ["org_metadata", "org_id"],
  ["org_members_metadata", "org_id || ':' || user_id"],
  ["org_members_cache", "org_id || ':' || user_id"],
  ["workflows", "id"],
  ["feature_guide_editions", "id"],
  ["feature_guide_receipts", "user_id || ':' || edition_id"],
  ["active_agent_runs", "run_id"],
  ["queued_chat_threads", "chat_thread_id"],
] as const;

async function workspaceBatches(sql: postgres.Sql) {
  const rows = await sql<
    { org_id: string }[]
  >`SELECT org_id FROM batch_scope ORDER BY org_id`;
  const batches: string[][] = [];
  for (let index = 0; index < rows.length; index += 50) {
    batches.push(
      rows.slice(index, index + 50).map((row) => {
        return row.org_id;
      }),
    );
  }
  return batches;
}

export async function captureInactiveBatch(
  sql: postgres.Sql,
  migrationSql: string,
  pendingMigrations: readonly string[] = [],
) {
  const boundary = migrationSql.indexOf(
    "-- Source definitions remain available",
  );
  assert.ok(boundary > 0, "The read-only preparation boundary must exist");
  // Only temporary preparation is materialized here. Give those tables session
  // lifetime instead of adding another transaction around the real migrator.
  for (const statement of migrationSql
    .slice(0, boundary)
    .split("--> statement-breakpoint")) {
    if (statement.trim())
      await sql.unsafe(
        statement
          .replaceAll("ON COMMIT DROP", "ON COMMIT PRESERVE ROWS")
          .replace("SET LOCAL TIME ZONE 'UTC'", "SET TIME ZONE 'UTC'"),
      );
  }
  await sql.unsafe(`
      CREATE TEMP TABLE batch_scope AS SELECT org_id FROM inactive_batch_cohort;
      CREATE TEMP TABLE batch_targets AS SELECT * FROM inactive_copy_target;
      CREATE TEMP TABLE batch_sources AS SELECT * FROM inactive_copy_agents;
      CREATE TEMP TABLE batch_workflows AS SELECT * FROM inactive_copy_workflows;
      CREATE TEMP TABLE batch_routes AS SELECT * FROM inactive_copy_chat_routes;
      CREATE TEMP TABLE batch_personal AS SELECT org_id,user_id,i.xmin::text || ':' || i.ctid::text AS fingerprint FROM instructions i;
      CREATE TEMP TABLE batch_flags AS SELECT * FROM user_feature_switches;
      CREATE TEMP TABLE batch_automations AS SELECT id,workflow_id,md5((to_jsonb(a)-'workflow_id')::text) AS fingerprint FROM workflow_automations a;
      CREATE TEMP TABLE batch_bindings AS SELECT id,workflow_id,md5((to_jsonb(b)-'workflow_id')::text) AS fingerprint FROM workflow_user_automation_threads b;
      CREATE TEMP TABLE batch_projects AS SELECT id,user_id,org_id,to_jsonb(p)->>'sort_order' AS sort_order,md5((to_jsonb(p)-'sort_order'-'updated_at')::text) AS fingerprint FROM projects p;
      CREATE TEMP TABLE batch_metadata (prior_project_sort_backfill boolean NOT NULL);
      CREATE TEMP TABLE batch_project_events AS SELECT id,md5((to_jsonb(e)-'sort_order'-'reorder_target_id'-'reorder_side')::text) AS fingerprint FROM project_events e;
      CREATE TEMP TABLE batch_project_sequences AS SELECT * FROM project_event_sequences;
      CREATE TEMP TABLE batch_chat_sequences AS SELECT * FROM chat_thread_event_sequences;
    `);
  await sql`INSERT INTO batch_metadata VALUES(${pendingMigrations.includes("1570_backfill_project_sort_order")})`;
  await sql.unsafe(
    "CREATE TEMP TABLE batch_runs (id uuid PRIMARY KEY,org_id text NOT NULL,fingerprint text NOT NULL)",
  );
  // Bound each complete org set instead of a full-table join on cold storage.
  // Every candidate org is covered, including those skipped by activation.
  for (const orgs of await workspaceBatches(sql)) {
    await sql`INSERT INTO batch_runs SELECT r.id,r.org_id,r.xmin::text || ':' || r.ctid::text
      FROM agent_runs r WHERE r.org_id=ANY(${orgs}::text[])`;
  }
  await sql.unsafe("CREATE INDEX ON batch_runs(org_id)");
  await sql.unsafe(`CREATE TEMP TABLE batch_chats AS
      SELECT c.id,c.agent_id,c.project_id,c.user_id,c.pin_order,c.last_message_at,
        c.xmin::text || ':' || c.ctid::text AS full_fingerprint,
        CASE WHEN EXISTS(SELECT 1 FROM batch_routes r WHERE r.id=c.id)
          THEN md5((to_jsonb(c)-'agent_id'-'project_id'-'updated_at')::text) END AS fingerprint FROM chat_threads c`);
  await sql.unsafe(`CREATE TEMP TABLE batch_chat_events AS
      SELECT e.id,md5(to_jsonb(e)::text) AS fingerprint FROM chat_thread_events e JOIN batch_scope s USING(org_id)`);
  for (const [table, key] of unchanged) {
    await sql.unsafe(
      `CREATE TEMP TABLE batch_original_${table} AS SELECT (${key})::text AS key,t.xmin::text || ':' || t.ctid::text AS fingerprint FROM ${table} t`,
    );
  }
  await sql.unsafe(`DROP TABLE pg_temp.inactive_copy_chat_routes,pg_temp.inactive_copy_workflows,
      pg_temp.inactive_copy_agents,pg_temp.inactive_copy_target,pg_temp.inactive_batch_cohort;
      DROP FUNCTION pg_temp.inactive_batch_uuid(text)`);
  const [counts] = await sql<
    {
      candidate_workspaces: number;
      eligible_workspaces: number;
      initialized_members: number;
      source_agents: number;
      source_workflows: number;
      legacy_chats: number;
      new_projects: number;
      new_personal_rows: number;
    }[]
  >`SELECT
    (SELECT count(*) FROM batch_scope)::int AS candidate_workspaces,
    (SELECT count(*) FROM batch_targets)::int AS eligible_workspaces,
    (SELECT coalesce(sum(cardinality(members)),0) FROM batch_targets)::int AS initialized_members,
    (SELECT count(*) FROM batch_sources)::int AS source_agents,
    (SELECT count(*) FROM batch_workflows)::int AS source_workflows,
    (SELECT count(*) FROM batch_routes)::int AS legacy_chats,
    (SELECT count(DISTINCT project_id) FROM batch_routes)::int AS new_projects,
    (SELECT count(*) FROM batch_targets t CROSS JOIN LATERAL unnest(t.members) m(user_id)
      LEFT JOIN batch_personal p ON p.org_id=t.org_id AND p.user_id=m.user_id WHERE p.org_id IS NULL)::int AS new_personal_rows`;
  assert.ok(counts);
  const skipped = await sql<
    { org_id: string }[]
  >`SELECT s.org_id FROM batch_scope s LEFT JOIN batch_targets t USING(org_id) WHERE t.org_id IS NULL ORDER BY s.org_id`;
  return {
    ...counts,
    skipped_org_ids: skipped.map((row) => {
      return row.org_id;
    }),
  };
}

export async function verifyInactiveBatch(sql: postgres.Sql) {
  const checks: Record<string, number> = {};
  async function check(name: string, query: string) {
    const rows = await sql.unsafe<{ n: number }[]>(query);
    assert.ok(rows[0]);
    checks[name] = rows[0].n;
  }
  for (const [table, key] of unchanged) {
    await check(
      `retained_${table}`,
      `SELECT count(*)::int AS n FROM batch_original_${table} b
      ${table === "workflows" ? "LEFT" : "FULL"} JOIN (SELECT (${key})::text AS key,t.xmin::text || ':' || t.ctid::text AS fingerprint FROM ${table} t) a USING(key)
      WHERE a.fingerprint IS DISTINCT FROM b.fingerprint`,
    );
  }
  checks.retained_runs = 0;
  for (const orgs of await workspaceBatches(sql)) {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM
      (SELECT id,fingerprint FROM batch_runs WHERE org_id=ANY(${orgs}::text[])) b FULL JOIN
      (SELECT r.id,r.xmin::text || ':' || r.ctid::text AS fingerprint FROM agent_runs r WHERE r.org_id=ANY(${orgs}::text[])) a USING(id)
      WHERE b.fingerprint IS DISTINCT FROM a.fingerprint`;
    assert.ok(row);
    checks.retained_runs += row.n;
  }
  await check(
    "retained_personal",
    `SELECT count(*)::int AS n FROM batch_personal b LEFT JOIN instructions i USING(org_id,user_id) WHERE b.fingerprint IS DISTINCT FROM i.xmin::text || ':' || i.ctid::text`,
  );
  await check(
    "initialized_personal",
    `SELECT count(*)::int AS n FROM batch_targets t CROSS JOIN LATERAL unnest(t.members) m(user_id)
    LEFT JOIN batch_personal b ON b.org_id=t.org_id AND b.user_id=m.user_id
    LEFT JOIN instructions i ON i.org_id=t.org_id AND i.user_id=m.user_id
    WHERE i.org_id IS NULL OR (b.org_id IS NULL AND (i.content IS DISTINCT FROM t.instructions OR i.bundle IS DISTINCT FROM t.instructions_bundle))`,
  );
  await check(
    "personal_row_delta",
    `SELECT abs((SELECT count(*) FROM instructions)-(SELECT count(*) FROM batch_personal)-
    (SELECT count(*) FROM batch_targets t CROSS JOIN LATERAL unnest(t.members) m(user_id)
      LEFT JOIN batch_personal p ON p.org_id=t.org_id AND p.user_id=m.user_id WHERE p.org_id IS NULL))::int AS n`,
  );
  await check(
    "member_flags",
    `SELECT count(*)::int AS n FROM batch_flags b FULL JOIN user_feature_switches f USING(org_id,user_id)
    LEFT JOIN batch_targets t ON t.org_id=f.org_id AND f.user_id=ANY(t.members)
    WHERE (to_jsonb(f)-'updated_at') IS DISTINCT FROM CASE WHEN t.org_id IS NULL THEN to_jsonb(b)-'updated_at'
      ELSE (to_jsonb(b)-'updated_at') || jsonb_build_object('switches',b.switches || '{"singleAgent":true}'::jsonb) END`,
  );
  await check(
    "workflow_copies",
    `SELECT count(*)::int AS n FROM batch_workflows s LEFT JOIN workflows w ON w.id=s.copy_id
    WHERE w.id IS NULL OR (to_jsonb(w)-'updated_at') IS DISTINCT FROM
      (to_jsonb(s)-ARRAY['copy_id','target_agent_id','source_agent_visibility','source_agent_owner','copy_visibility','copy_name','source_row_version','updated_at'])
      || jsonb_build_object('id',s.copy_id,'agent_id',s.target_agent_id,'name',s.copy_name,'visibility',s.copy_visibility)`,
  );
  await check(
    "instruction_workflows",
    `SELECT count(*)::int AS n FROM batch_sources a LEFT JOIN workflows w
    ON w.id=overlay(overlay(md5('inactive-batch-instruction-v1:' || a.id::text) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
    WHERE w.id IS NULL OR w.org_id<>a.org_id OR w.agent_id<>a.target_agent_id OR w.owner_user_id<>a.owner OR w.visibility<>a.visibility
      OR w.name<>a.prefix || '--instruction' OR w.instruction IS DISTINCT FROM a.instructions
      OR w.content_bundle IS DISTINCT FROM a.instructions_bundle OR w.attachments IS DISTINCT FROM '{"kind":"empty"}'::jsonb`,
  );
  await check(
    "workflow_row_delta",
    `SELECT abs((SELECT count(*) FROM workflows)-(SELECT count(*) FROM batch_original_workflows)
    -(SELECT count(*) FROM batch_sources)-(SELECT count(*) FROM batch_workflows))::int AS n`,
  );
  await check(
    "automation_identity_state",
    `SELECT count(*)::int AS n FROM batch_automations b LEFT JOIN workflow_automations a USING(id)
    LEFT JOIN batch_workflows w ON w.id=b.workflow_id
    WHERE b.fingerprint IS DISTINCT FROM md5((to_jsonb(a)-'workflow_id')::text) OR a.workflow_id IS DISTINCT FROM coalesce(w.copy_id,b.workflow_id)`,
  );
  await check(
    "automation_thread_bindings",
    `SELECT count(*)::int AS n FROM batch_bindings b LEFT JOIN workflow_user_automation_threads a USING(id)
    LEFT JOIN batch_workflows w ON w.id=b.workflow_id
    WHERE b.fingerprint IS DISTINCT FROM md5((to_jsonb(a)-'workflow_id')::text) OR a.workflow_id IS DISTINCT FROM coalesce(w.copy_id,b.workflow_id)`,
  );
  await check(
    "automation_row_delta",
    `SELECT (abs((SELECT count(*) FROM workflow_automations)-(SELECT count(*) FROM batch_automations))
    +abs((SELECT count(*) FROM workflow_user_automation_threads)-(SELECT count(*) FROM batch_bindings)))::int AS n`,
  );
  await check(
    "chat_payload",
    `SELECT count(*)::int AS n FROM batch_chats b JOIN batch_routes r USING(id) LEFT JOIN chat_threads c USING(id)
    WHERE b.fingerprint IS DISTINCT FROM md5((to_jsonb(c)-'agent_id'-'project_id'-'updated_at')::text)`,
  );
  await check(
    "chat_routes",
    `SELECT count(*)::int AS n FROM batch_routes r LEFT JOIN chat_threads c USING(id)
    WHERE c.id IS NULL OR c.agent_id<>r.target_agent_id OR c.user_id<>r.user_id OR c.project_id IS DISTINCT FROM r.project_id`,
  );
  await check(
    "other_chats",
    `SELECT count(*)::int AS n FROM batch_chats b LEFT JOIN chat_threads c USING(id)
    LEFT JOIN batch_routes r USING(id) WHERE r.id IS NULL AND b.full_fingerprint IS DISTINCT FROM c.xmin::text || ':' || c.ctid::text`,
  );
  await check(
    "chat_row_delta",
    `SELECT abs((SELECT count(*) FROM chat_threads)-(SELECT count(*) FROM batch_chats))::int AS n`,
  );
  await check(
    "retained_projects",
    `SELECT count(*)::int AS n FROM batch_projects b LEFT JOIN projects p USING(id)
    WHERE b.fingerprint IS DISTINCT FROM md5((to_jsonb(p)-'sort_order'-'updated_at')::text)`,
  );
  await check(
    "project_routes",
    `SELECT count(*)::int AS n FROM batch_routes r LEFT JOIN projects p ON p.id=r.project_id
    WHERE p.id IS NULL OR p.user_id<>r.user_id OR p.org_id<>r.org_id OR p.name<>r.project_name OR p.sort_order !~ '^a0[0-9]{17}1$' OR p.sort_order IS NULL`,
  );
  await check(
    "project_row_delta",
    `SELECT abs((SELECT count(*) FROM projects)-(SELECT count(*) FROM batch_projects)
    -(SELECT count(DISTINCT project_id) FROM batch_routes))::int AS n`,
  );
  await check(
    "retained_project_events",
    `SELECT count(*)::int AS n FROM batch_project_events b LEFT JOIN project_events e USING(id)
    WHERE b.fingerprint IS DISTINCT FROM md5((to_jsonb(e)-'sort_order'-'reorder_target_id'-'reorder_side')::text)`,
  );
  await check(
    "project_created_events",
    `SELECT count(*)::int AS n FROM (SELECT DISTINCT project_id,user_id,org_id FROM batch_routes) r
    LEFT JOIN projects p ON p.id=r.project_id
    WHERE (SELECT count(*) FROM project_events e LEFT JOIN batch_project_events b USING(id)
      WHERE b.id IS NULL AND e.project_id=r.project_id AND e.org_id=r.org_id AND e.user_id=r.user_id
        AND e.kind='created' AND e.name=p.name AND e.sort_order=p.sort_order)<>1`,
  );
  await check(
    "project_sequences",
    `SELECT count(*)::int AS n FROM project_event_sequences s FULL JOIN batch_project_sequences b USING(user_id,org_id)
    WHERE s.last_seq_id IS DISTINCT FROM coalesce(b.last_seq_id,0)+(SELECT count(DISTINCT r.project_id) FROM batch_routes r WHERE r.org_id=s.org_id AND r.user_id=s.user_id)
      +CASE WHEN (SELECT prior_project_sort_backfill FROM batch_metadata) THEN
        (SELECT count(*) FROM batch_projects p WHERE p.sort_order IS NULL AND p.org_id=s.org_id AND p.user_id=s.user_id) ELSE 0 END`,
  );
  await check(
    "retained_chat_events",
    `SELECT count(*)::int AS n FROM batch_chat_events b LEFT JOIN chat_thread_events e USING(id) WHERE b.fingerprint IS DISTINCT FROM md5(to_jsonb(e)::text)`,
  );
  await check(
    "new_chat_events",
    `SELECT count(*)::int AS n FROM batch_routes r JOIN batch_chats c USING(id)
    WHERE (SELECT count(*) FROM chat_thread_events e LEFT JOIN batch_chat_events b USING(id)
      WHERE b.id IS NULL AND e.chat_thread_id=r.id AND e.user_id=r.user_id AND e.org_id=r.org_id AND e.agent_id=r.target_agent_id
        AND ((e.kind='project_updated' AND e.project_id=r.project_id)
          OR (e.kind='sort_touched' AND e.reassigned_agent_id=r.target_agent_id AND e.pin_order IS NOT DISTINCT FROM c.pin_order
            AND e.created_at IS NOT DISTINCT FROM c.last_message_at)))<>2`,
  );
  await check(
    "chat_sequences",
    `SELECT count(*)::int AS n FROM chat_thread_event_sequences s FULL JOIN batch_chat_sequences b USING(user_id,org_id)
    WHERE s.last_seq_id IS DISTINCT FROM coalesce(b.last_seq_id,0)+2*(SELECT count(*) FROM batch_routes r WHERE r.org_id=s.org_id AND r.user_id=s.user_id)`,
  );
  return checks;
}
