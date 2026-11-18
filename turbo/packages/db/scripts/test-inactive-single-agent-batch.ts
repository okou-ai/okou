import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  array,
  number,
  object,
  string,
  tuple,
  uuid,
  type infer as Infer,
} from "zod";
import { prepareContentBundle } from "@okouai/core/content-bundle";
import { prepareWorkflowAttachmentBundle } from "@okouai/core/workflow-attachment-bundle";
import { applyPendingMigrations } from "./migration-runner";
import {
  captureInactiveBatch,
  verifyInactiveBatch,
} from "./inactive-single-agent-batch-verification";

const connection = process.env.DATABASE_URL;
assert.ok(connection, "Fixture-owned local DATABASE_URL required");
assert.ok(
  ["localhost", "127.0.0.1", "postgres"].includes(new URL(connection).hostname),
);
const admin = postgres(connection, { max: 1, onnotice: () => {} });
const journal = object({
  entries: array(object({ tag: string(), when: number() })),
}).parse(
  JSON.parse(
    await readFile(
      new URL("../src/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ),
);
const migration = journal.entries.find((row) => {
  return row.tag === "1572_copy_inactive_single_agent_batch";
});
assert.ok(migration);
const text = await readFile(
  new URL(`../src/migrations/${migration.tag}.sql`, import.meta.url),
  "utf8",
);
const cohortSchema = object({
  org_id: string(),
  default_agent_id: uuid(),
  members: array(string()).min(1),
  cached_members: array(string()),
  agents: array(uuid()),
  workflows: array(uuid()),
  automations: array(uuid()),
  chats: array(uuid()),
});
type Cohort = Infer<typeof cohortSchema>;
const compactCohort = array(
  tuple([
    string(),
    uuid(),
    array(string()),
    array(string()),
    array(uuid()),
    array(uuid()),
    array(uuid()),
    array(uuid()),
  ]),
)
  .length(6589)
  .parse(JSON.parse(text.split("$cohort$")[1]!));
const cohort = array(cohortSchema).parse(
  compactCohort.map(
    ([
      orgId,
      defaultAgentId,
      members,
      extra,
      sources,
      workflows,
      automations,
      chats,
    ]) => {
      return {
        org_id: orgId,
        default_agent_id: defaultAgentId,
        members,
        cached_members: [...members, ...extra].sort(),
        agents: [defaultAgentId, ...sources].sort(),
        workflows,
        automations,
        chats,
      };
    },
  ),
);
const used = new Set<string>();
function take(predicate: (row: Cohort) => boolean) {
  const row = cohort.find((row) => {
    return !used.has(row.org_id) && predicate(row);
  });
  assert.ok(
    row,
    "The frozen cohort must provide the exercised migration shape",
  );
  used.add(row.org_id);
  return row;
}
function stableId(value: string) {
  const hash = createHash("md5").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}
const simple = (row: Cohort) => {
  return (
    row.agents.length === 1 &&
    row.workflows.length === 0 &&
    row.automations.length === 0 &&
    row.members.length === 1 &&
    row.cached_members.length === 1
  );
};
const cases = [
  { name: "default", row: take(simple), accepted: true },
  {
    name: "multiple-members",
    row: take((row) => {
      return row.members.length === 2;
    }),
    accepted: true,
  },
  {
    name: "default-workflows",
    row: take((row) => {
      return (
        row.agents.length === 1 &&
        row.workflows.length > 0 &&
        row.automations.length > 0
      );
    }),
    accepted: true,
  },
  {
    name: "legacy-private",
    row: take((row) => {
      return (
        row.agents.length > 1 &&
        row.workflows.length > 0 &&
        row.automations.length > 0 &&
        row.chats.length > 0 &&
        row.members.length === 1
      );
    }),
    accepted: true,
  },
  {
    name: "legacy-public",
    row: take((row) => {
      return (
        row.agents.length > 2 &&
        row.chats.length > 1 &&
        row.members.length === 1
      );
    }),
    accepted: true,
  },
  {
    name: "enabled-automation",
    row: take((row) => {
      return (
        row.agents.length === 1 &&
        row.workflows.length > 0 &&
        row.automations.length > 0
      );
    }),
    accepted: false,
  },
  {
    name: "legacy-without-automation",
    row: take((row) => {
      return (
        row.agents.length > 1 &&
        row.workflows.length > 0 &&
        row.automations.length === 0 &&
        row.chats.length > 0 &&
        row.members.length === 1
      );
    }),
    accepted: true,
  },
  {
    name: "private-owner-mismatch",
    row: take((row) => {
      return (
        row.agents.length > 1 &&
        row.workflows.length > 0 &&
        row.automations.length === 0 &&
        row.members.length === 1
      );
    }),
    accepted: false,
  },
  ...[
    "failed-run",
    "scheduled-run",
    "old-pending",
    "active",
    "queued",
    "young-org",
    "young-member",
    "new-member",
    "new-agent",
    "missing-bundle",
    "already-enabled",
    "existing-project",
  ].map((name) => {
    return { name, row: take(simple), accepted: false };
  }),
];
const database = `inactive_batch_${randomUUID().replaceAll("-", "")}`;
const address = new URL(connection);
address.pathname = `/${database}`;
const sql = postgres(address.toString(), { max: 1, onnotice: () => {} });
const body = "Retained authored content";
const bundle = await prepareContentBundle([
  { path: "instructions.md", content: Buffer.from(body) },
]);
const empty = await prepareContentBundle([
  { path: "instructions.md", content: Buffer.alloc(0) },
]);
const content = await prepareContentBundle([
  {
    path: "SKILL.md",
    content: Buffer.from("---\nname: original\n---\nRetained workflow"),
  },
  { path: "assets/raw.bin", content: Buffer.from([0, 128, 255]) },
]);
const unchangedTables = [
  "agents",
  "agent_runs",
  "org_metadata",
  "org_members_metadata",
  "org_members_cache",
  "feature_guide_editions",
  "feature_guide_receipts",
  "active_agent_runs",
  "queued_chat_threads",
];
async function snapshot() {
  const values: string[] = [];
  for (const table of unchangedTables) {
    values.push(
      JSON.stringify(
        await sql.unsafe(
          `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
        ),
      ),
    );
  }
  return values;
}
async function anomalies(statement: string) {
  const rows = await sql.unsafe<{ n: number }[]>(statement);
  assert.equal(rows[0]?.n, 0, statement);
}

try {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await applyPendingMigrations(sql, { beforeMillis: migration.when });
  for (const entry of cases) {
    const c = entry.row;
    const owner = c.members[0]!;
    const sources = c.agents.filter((id) => {
      return id !== c.default_agent_id;
    });
    const privateSource =
      entry.name === "legacy-private" ||
      entry.name === "private-owner-mismatch";
    for (const [index, id] of c.agents.entries()) {
      const isDefault = id === c.default_agent_id;
      await sql`INSERT INTO agents(id,org_id,owner,name,display_name,visibility,instructions,instructions_bundle)
        VALUES(${id},${c.org_id},${owner},${isDefault ? "okou" : `legacy-${index}`},
          ${isDefault ? "Okou" : "同名助手"},${!isDefault && privateSource ? "private" : "public"},${body},${sql.json(bundle.descriptor)})`;
    }
    await sql`INSERT INTO org_metadata(org_id,default_agent_id,created_at)
      VALUES(${c.org_id},${c.default_agent_id},now()-interval '60 days')`;
    for (const user of c.members) {
      await sql`INSERT INTO org_members_metadata(org_id,user_id,created_at) VALUES(${c.org_id},${user},now()-interval '60 days')`;
      await sql`INSERT INTO user_feature_switches(org_id,user_id,switches)
        VALUES(${c.org_id},${user},'{"singleAgent":false,"featureGuides":false,"unrelated":true}')`;
    }
    for (const user of c.cached_members) {
      await sql`INSERT INTO org_members_cache(org_id,user_id,role) VALUES(${c.org_id},${user},${user === owner ? "admin" : "member"})`;
    }
    // Deliberately empty saved content survives; other initialized members need a row.
    await sql`INSERT INTO instructions(org_id,user_id,content,bundle)
      VALUES(${c.org_id},${owner},'',${sql.json(empty.descriptor)})`;
    const defaultChat = randomUUID();
    await sql`INSERT INTO chat_threads(id,user_id,agent_id,title,framework,framework_session_id)
      VALUES(${defaultChat},${owner},${c.default_agent_id},'default history','codex','retained-default-session')`;
    for (const [index, id] of c.chats.entries()) {
      assert.ok(sources.length > 0);
      await sql`INSERT INTO chat_threads(id,user_id,agent_id,title,framework,framework_session_id,last_message_at,last_read_at)
        VALUES(${id},${owner},${sources[index % sources.length]!},'legacy history','codex',${`native-${id}`},
          now()-interval '60 days',now()-interval '60 days')`;
    }
    for (const [index, id] of c.workflows.entries()) {
      const attachments = await prepareWorkflowAttachmentBundle(c.org_id, id, [
        { path: "assets/raw.bin", content: Buffer.from([0, 128, 255]) },
      ]);
      // The long slug exercises the deployed prefixed-package adapter's hash path.
      await sql`INSERT INTO workflows(id,org_id,agent_id,name,visibility,owner_user_id,instruction,attachments,content_bundle,
        description,display_name,created_by,updated_by,import_source)
        VALUES(${id},${c.org_id},${sources[0] ?? c.default_agent_id},${index === 0 ? "x".repeat(64) : `ordinary-${index}`},
          ${index % 2 ? "private" : "public"},${entry.name === "private-owner-mismatch" ? "foreign-owner" : owner},'Retained workflow',${sql.json(attachments.descriptor)},
          ${sql.json(content.descriptor)},'description','Display',${owner},${owner},'codex')`;
    }
    for (const [index, id] of c.automations.entries()) {
      const workflow = c.workflows[index % c.workflows.length];
      assert.ok(workflow);
      await sql`INSERT INTO workflow_automations(id,org_id,workflow_id,owner_user_id,kind,schedule_type,interval_seconds,
        enabled,next_run_at,last_run_at,consecutive_failures)
        VALUES(${id},${c.org_id},${workflow},${owner},'schedule','loop',1800,false,NULL,now()-interval '60 days',3)`;
    }
    for (const workflow of c.workflows) {
      await sql`INSERT INTO workflow_user_automation_threads(id,org_id,user_id,workflow_id,chat_thread_id)
        VALUES(${randomUUID()},${c.org_id},${owner},${workflow},${c.chats[0] ?? defaultChat})`;
    }
    const history = randomUUID();
    await sql`INSERT INTO agent_runs(id,org_id,user_id,agent_id,chat_thread_id,status,prompt,trigger_source,autonomy_budget,created_at)
      VALUES(${history},${c.org_id},${owner},${sources[0] ?? c.default_agent_id},${c.chats[0] ?? defaultChat},
        'completed','Retained history','web',0,now()-interval '60 days')`;
    if (
      entry.name === "failed-run" ||
      entry.name === "scheduled-run" ||
      entry.name === "old-pending"
    ) {
      await sql`INSERT INTO agent_runs(id,org_id,user_id,agent_id,status,prompt,trigger_source,autonomy_budget,created_at)
        VALUES(${randomUUID()},${c.org_id},${owner},${c.default_agent_id},
          ${entry.name === "old-pending" ? "pending" : entry.name === "failed-run" ? "failed" : "completed"},'Activity',
          ${entry.name === "scheduled-run" ? "automation-schedule" : "web"},0,
          ${new Date(Date.now() - (entry.name === "old-pending" ? 60 : entry.name === "failed-run" ? 30 - 1 / 24 : 1) * 86400000)})`;
    }
    if (entry.name === "active")
      await sql`INSERT INTO active_agent_runs(run_id,org_id,user_id,chat_thread_id,last_heartbeat_at) VALUES(${history},${c.org_id},${owner},${defaultChat},now())`;
    if (entry.name === "queued")
      await sql`INSERT INTO queued_chat_threads(chat_thread_id,org_id,queued_at) VALUES(${defaultChat},${c.org_id},now())`;
    if (entry.name === "enabled-automation")
      await sql`UPDATE workflow_automations SET enabled=true WHERE org_id=${c.org_id}`;
    if (entry.name === "young-org")
      await sql`UPDATE org_metadata SET created_at=now() WHERE org_id=${c.org_id}`;
    if (entry.name === "young-member")
      await sql`UPDATE org_members_metadata SET created_at=now() WHERE org_id=${c.org_id}`;
    if (entry.name === "new-member")
      await sql`INSERT INTO org_members_metadata(org_id,user_id) VALUES(${c.org_id},'new-unreviewed-member')`;
    if (entry.name === "new-agent")
      await sql`INSERT INTO agents(id,org_id,owner,name,visibility,instructions_bundle) VALUES(${randomUUID()},${c.org_id},${owner},'unreviewed','public',${sql.json(bundle.descriptor)})`;
    if (entry.name === "missing-bundle")
      await sql`UPDATE agents SET instructions_bundle=NULL WHERE id=${c.default_agent_id}`;
    if (entry.name === "already-enabled")
      await sql`UPDATE user_feature_switches SET switches=switches || '{"singleAgent":true}'::jsonb WHERE org_id=${c.org_id}`;
    if (entry.name === "existing-project")
      await sql`INSERT INTO projects(id,org_id,user_id,name) VALUES(${randomUUID()},${c.org_id},${owner},'existing')`;
  }
  await sql`INSERT INTO user_feature_switches(org_id,user_id,switches) VALUES('outside-cohort','outside','{"singleAgent":false}')`;
  const eligible = cases.filter((entry) => {
    return entry.accepted;
  });
  const legacy = eligible.find((entry) => {
    return entry.row.chats.length > 0;
  })!;
  const source = legacy.row.agents.find((id) => {
    return id !== legacy.row.default_agent_id;
  })!;
  const collision = stableId(
    `inactive-batch-project-v1:${legacy.row.org_id}:${legacy.row.members[0]}:${source}`,
  );
  await sql`INSERT INTO projects(id,org_id,user_id,name) VALUES(${collision},'outside-cohort','outside','identity collision')`;
  await sql.unsafe("SET TIME ZONE 'Asia/Shanghai'");
  const before = await snapshot();
  const frontier =
    await sql`SELECT max(created_at)::text AS value FROM drizzle.__drizzle_migrations`;
  await assert.rejects(
    applyPendingMigrations(sql),
    /Inactive batch Project copy identity collision/u,
  );
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(
    await sql`SELECT max(created_at)::text AS value FROM drizzle.__drizzle_migrations`,
    frontier,
  );
  await sql`DELETE FROM projects WHERE id=${collision}`;
  const captured = await captureInactiveBatch(sql, text);
  assert.equal(captured.eligible_workspaces, eligible.length);
  await sql.unsafe(`
    CREATE TEMP TABLE before_workflows AS SELECT * FROM workflows;
    CREATE TEMP TABLE before_automations AS SELECT * FROM workflow_automations;
    CREATE TEMP TABLE before_bindings AS SELECT * FROM workflow_user_automation_threads;
    CREATE TEMP TABLE before_chats AS SELECT * FROM chat_threads;
    CREATE TEMP TABLE before_personal AS SELECT * FROM instructions;
    CREATE TEMP TABLE before_flags AS SELECT * FROM user_feature_switches;
  `);
  await applyPendingMigrations(sql);
  assert.deepEqual(await snapshot(), before);
  const batchChecks = await verifyInactiveBatch(sql);
  assert.ok(
    Object.values(batchChecks).every((count) => {
      return count === 0;
    }),
    JSON.stringify(batchChecks),
  );
  await anomalies(
    `SELECT count(*)::int AS n FROM before_workflows b LEFT JOIN workflows w USING(id) WHERE to_jsonb(w) IS DISTINCT FROM to_jsonb(b)`,
  );
  await anomalies(
    `SELECT count(*)::int AS n FROM before_personal b LEFT JOIN instructions i USING(org_id,user_id) WHERE to_jsonb(i) IS DISTINCT FROM to_jsonb(b)`,
  );
  await anomalies(`SELECT count(*)::int AS n FROM before_chats b LEFT JOIN chat_threads c USING(id)
    WHERE (to_jsonb(c)-'agent_id'-'project_id'-'updated_at') IS DISTINCT FROM (to_jsonb(b)-'agent_id'-'project_id'-'updated_at')`);
  for (const entry of cases) {
    const c = entry.row;
    for (const user of c.members) {
      const [flag] =
        await sql`SELECT switches FROM user_feature_switches WHERE org_id=${c.org_id} AND user_id=${user}`;
      assert.deepEqual(
        flag?.switches,
        {
          singleAgent: entry.accepted || entry.name === "already-enabled",
          featureGuides: false,
          unrelated: true,
        },
        entry.name,
      );
      const [personal] =
        await sql`SELECT content,bundle FROM instructions WHERE org_id=${c.org_id} AND user_id=${user}`;
      if (entry.accepted)
        assert.deepEqual(personal, {
          content: user === c.members[0] ? "" : body,
          bundle: user === c.members[0] ? empty.descriptor : bundle.descriptor,
        });
    }
    const [copies] =
      await sql`SELECT count(*)::int AS n FROM workflows w LEFT JOIN before_workflows b USING(id) WHERE w.org_id=${c.org_id} AND b.id IS NULL`;
    assert.equal(
      copies?.n,
      entry.accepted
        ? c.agents.length - 1 + (c.agents.length > 1 ? c.workflows.length : 0)
        : 0,
      entry.name,
    );
    for (const id of c.chats) {
      const [chat] =
        await sql`SELECT agent_id,project_id FROM chat_threads WHERE id=${id}`;
      const [original] =
        await sql`SELECT agent_id FROM before_chats WHERE id=${id}`;
      assert.equal(
        chat?.agent_id,
        entry.accepted ? c.default_agent_id : original?.agent_id,
      );
      assert.equal(
        chat?.project_id,
        entry.accepted
          ? stableId(
              `inactive-batch-project-v1:${c.org_id}:${c.members[0]}:${original?.agent_id}`,
            )
          : null,
      );
    }
    const [events] =
      await sql`SELECT count(*)::int AS n FROM chat_thread_events WHERE org_id=${c.org_id}`;
    assert.equal(events?.n, entry.accepted ? 2 * c.chats.length : 0);
  }
  await anomalies(`SELECT count(*)::int AS n FROM before_automations b JOIN before_workflows w ON w.id=b.workflow_id
    JOIN org_metadata o ON o.org_id=w.org_id LEFT JOIN workflow_automations a ON a.id=b.id
    WHERE (to_jsonb(a)-'workflow_id') IS DISTINCT FROM (to_jsonb(b)-'workflow_id')
      OR a.workflow_id IS DISTINCT FROM CASE WHEN EXISTS(SELECT 1 FROM workflows copy WHERE copy.id=
        overlay(overlay(md5('inactive-batch-workflow-v1:' || w.id::text) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid)
        THEN overlay(overlay(md5('inactive-batch-workflow-v1:' || w.id::text) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid ELSE b.workflow_id END`);
  await anomalies(`SELECT count(*)::int AS n FROM before_bindings b LEFT JOIN workflow_user_automation_threads t USING(id)
    WHERE (to_jsonb(t)-'workflow_id') IS DISTINCT FROM (to_jsonb(b)-'workflow_id')
      OR t.workflow_id IS DISTINCT FROM COALESCE((SELECT copy.id FROM workflows copy WHERE copy.id=
        overlay(overlay(md5('inactive-batch-workflow-v1:' || b.workflow_id::text) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid),b.workflow_id)`);
  await anomalies(`SELECT count(*)::int AS n FROM before_workflows b JOIN org_metadata o ON o.org_id=b.org_id
    JOIN agents source ON source.id=b.agent_id
    JOIN workflows w ON w.id=overlay(overlay(md5('inactive-batch-workflow-v1:' || b.id::text) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
    WHERE w.agent_id<>o.default_agent_id OR w.owner_user_id<>b.owner_user_id
      OR w.visibility<>CASE WHEN source.visibility='private' THEN 'private' ELSE b.visibility END
      OR (to_jsonb(w)-'id'-'agent_id'-'name'-'updated_at'-'visibility') IS DISTINCT FROM (to_jsonb(b)-'id'-'agent_id'-'name'-'updated_at'-'visibility')`);
  await anomalies(`SELECT count(*)::int AS n FROM projects p LEFT JOIN project_events e ON e.project_id=p.id AND e.kind='created'
    WHERE p.org_id<>'outside-cohort' AND p.name<>'existing' AND (p.sort_order IS NULL OR e.id IS NULL OR e.sort_order IS DISTINCT FROM p.sort_order)`);
  await anomalies(
    `SELECT count(*)::int AS n FROM project_event_sequences s WHERE s.last_seq_id<>(SELECT max(e.seq_id) FROM project_events e WHERE e.org_id=s.org_id AND e.user_id=s.user_id)`,
  );
  await anomalies(
    `SELECT count(*)::int AS n FROM chat_thread_event_sequences s WHERE s.last_seq_id<>(SELECT max(e.seq_id) FROM chat_thread_events e WHERE e.org_id=s.org_id AND e.user_id=s.user_id)`,
  );
  const [outside] =
    await sql`SELECT switches FROM user_feature_switches WHERE org_id='outside-cohort'`;
  assert.deepEqual(outside?.switches, { singleAgent: false });
  const after =
    await sql`SELECT (SELECT count(*) FROM workflows)::int AS workflows,(SELECT count(*) FROM projects)::int AS projects,
    (SELECT count(*) FROM project_events)::int AS projects_events,(SELECT count(*) FROM chat_thread_events)::int AS chat_events`;
  await applyPendingMigrations(sql);
  assert.deepEqual(
    await sql`SELECT (SELECT count(*) FROM workflows)::int AS workflows,(SELECT count(*) FROM projects)::int AS projects,
    (SELECT count(*) FROM project_events)::int AS projects_events,(SELECT count(*) FROM chat_thread_events)::int AS chat_events`,
    after,
  );
  // A payload-only rewrite must be detected even though all history IDs and
  // routing references remain the same and no large Run body is fetched.
  const [retainedRun] = await sql<
    { id: string }[]
  >`SELECT id FROM agent_runs ORDER BY id LIMIT 1`;
  assert.ok(retainedRun);
  await sql`UPDATE agent_runs SET prompt=${"changed payload".repeat(4096)} WHERE id=${retainedRun.id}`;
  const changed = await verifyInactiveBatch(sql);
  assert.equal(changed.retained_runs, 1);
  assert.ok(
    Object.entries(changed).every(([name, count]) => {
      return name === "retained_runs" || count === 0;
    }),
  );
  console.log(
    `Inactive batch migration: ${cases.length} real-database cases passed, including atomic rollback, journal retry and payload-only corruption detection`,
  );
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
}
