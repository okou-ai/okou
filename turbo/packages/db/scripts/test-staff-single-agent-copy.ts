import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { array, number, object, string, uuid } from "zod";
import { prepareContentBundle } from "@okouai/core/content-bundle";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { prepareWorkflowAttachmentBundle } from "@okouai/core/workflow-attachment-bundle";
import {
  STAFF_SINGLE_AGENT_ORG_ID as org,
  staffWorkflowCopyId,
} from "@okouai/core/staff-single-agent-migration";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
} from "@okouai/api-contracts/contracts/chat-threads";
import { applyPendingMigrations } from "./migration-runner";

// A real release-migration boundary on a fixture-owned local database. No API
// service or worker is called, and no external storage credentials are needed.
const connection = process.env.DATABASE_URL;
assert.ok(connection, "Disposable local DATABASE_URL required");
assert.ok(
  ["localhost", "127.0.0.1", "postgres"].includes(new URL(connection).hostname),
);
const database = `staff_copy_${randomUUID().replaceAll("-", "")}`;
const address = new URL(connection);
address.pathname = `/${database}`;
const admin = postgres(connection, { max: 1, onnotice: () => {} });
const sql = postgres(address.toString(), { max: 1, onnotice: () => {} });
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
const migration = journal.entries.find((entry) => {
  return entry.tag === "1548_copy_staff_single_agent";
});
assert.ok(migration);
const stableId = (value: string) => {
  const digest = createHash("md5").update(value).digest("hex");
  return uuid().parse(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`,
  );
};
const owner = "staff-alice",
  other = "staff-bob",
  administrator = "staff-admin";
const target = randomUUID(),
  privateAgent = "0300e951-f501-4856-8f4c-09fdc34ce651",
  publicAgent = "06ba1ce5-3ed2-417b-a5c9-cc96a35b1d43";
const workflow = randomUUID(),
  second = randomUUID(),
  publicWorkflow = randomUUID();
const chat = randomUUID(),
  otherChat = randomUUID(),
  oldProject = randomUUID();
const kept = randomUUID(),
  disabled = randomUUID(),
  invalid = randomUUID(),
  binding = randomUUID();
const running = randomUUID(),
  pending = randomUUID(),
  historical = randomUUID();
const foreignOrg = `foreign-${randomUUID()}`,
  foreignAgent = randomUUID();
const collision = stableId(
  `staff-single-agent-project-v1:${org}:${owner}:${privateAgent}`,
);

async function preserved() {
  return JSON.stringify([
    Array.from(await sql`SELECT * FROM agents ORDER BY id`),
    Array.from(
      await sql`SELECT * FROM workflows WHERE agent_id<>${target} ORDER BY id`,
    ),
    Array.from(await sql`SELECT * FROM chat_events ORDER BY id`),
    Array.from(await sql`SELECT * FROM chat_automation_context ORDER BY id`),
    Array.from(await sql`SELECT * FROM active_agent_runs ORDER BY run_id`),
    Array.from(
      await sql`SELECT * FROM queued_chat_threads ORDER BY chat_thread_id`,
    ),
    Array.from(
      await sql`SELECT * FROM agent_runs WHERE id<>${historical} ORDER BY id`,
    ),
    Array.from(
      await sql`SELECT * FROM chat_threads WHERE agent_id=${foreignAgent}`,
    ),
    Array.from(
      await sql`SELECT * FROM user_feature_switches WHERE org_id=${foreignOrg}`,
    ),
  ]);
}

try {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await applyPendingMigrations(sql, { beforeMillis: migration.when });
  const instruction = "  default Instructions\r\n正文\n";
  const instructions = await prepareContentBundle([
    { path: "instructions.md", content: Buffer.from(instruction) },
  ]);
  const empty = await prepareContentBundle([
    { path: "instructions.md", content: Buffer.alloc(0) },
  ]);
  const files = [
    { path: "assets/raw.bin", content: Buffer.from([0, 255, 128]) },
  ];
  const attachments = await prepareWorkflowAttachmentBundle(
    org,
    workflow,
    files,
  );
  const content = await prepareContentBundle([
    {
      path: "SKILL.md",
      content: Buffer.from(
        synthesizeWorkflowSkillMd({
          name: "original",
          description: "retained",
          instruction: "body",
        }),
      ),
    },
    ...files,
  ]);
  const secondContent = await prepareContentBundle([
    {
      path: "SKILL.md",
      content: Buffer.from(
        synthesizeWorkflowSkillMd({
          name: "second",
          description: null,
          instruction: "body",
        }),
      ),
    },
  ]);
  const publicContent = await prepareContentBundle([
    {
      path: "SKILL.md",
      content: Buffer.from(
        synthesizeWorkflowSkillMd({
          name: "a".repeat(64),
          description: null,
          instruction: "body",
        }),
      ),
    },
  ]);
  await sql`INSERT INTO agents(id,org_id,owner,name,display_name,visibility,instructions,instructions_bundle)
    VALUES(${target},${org},${administrator},'okou','Okou','public',${instruction},${sql.json(instructions.descriptor)}),
      (${privateAgent},${org},${owner},'private-ada','Ada','private',${instruction},${sql.json(instructions.descriptor)}),
      (${publicAgent},${org},${administrator},'public-ada','Ada','public',${instruction},${sql.json(instructions.descriptor)}),
      (${foreignAgent},${foreignOrg},'foreign','foreign','Foreign','public','foreign',${sql.json(instructions.descriptor)})`;
  await sql`INSERT INTO org_metadata(org_id,default_agent_id) VALUES(${org},${target}),(${foreignOrg},${foreignAgent})`;
  await sql`INSERT INTO org_members_cache(org_id,user_id,role) VALUES(${org},${owner},'member'),(${org},${other},'member'),(${org},${administrator},'admin')`;
  await sql`INSERT INTO instructions(org_id,user_id,content,bundle) VALUES(${org},${owner},'',${sql.json(empty.descriptor)})`;
  await sql`INSERT INTO user_feature_switches(org_id,user_id,switches) VALUES(${org},${owner},'{"singleAgent":false,"otherFlag":true}'),(${foreignOrg},'foreign','{"singleAgent":false}')`;
  await sql`INSERT INTO workflows(id,org_id,agent_id,name,visibility,owner_user_id,instruction,description,content_bundle,created_by,updated_by,attachments)
    VALUES(${workflow},${org},${privateAgent},'original','public',${other},'body','retained',${sql.json(content.descriptor)},${other},${other},${sql.json(attachments.descriptor)}),
      (${second},${org},${privateAgent},'second','private',${owner},'body',NULL,${sql.json(secondContent.descriptor)},${owner},${owner},'{"kind":"empty"}'),
      (${publicWorkflow},${org},${publicAgent},${"a".repeat(64)},'public',${other},'body',NULL,${sql.json(publicContent.descriptor)},${other},${other},'{"kind":"empty"}')`;
  await sql`INSERT INTO projects(id,org_id,user_id,name) VALUES(${oldProject},${org},${owner},'Existing'),(${collision},${foreignOrg},'foreign','collision')`;
  await sql`INSERT INTO chat_threads(id,user_id,agent_id,project_id,title,framework,framework_session_id,framework_session_run_id)
    VALUES(${chat},${owner},${privateAgent},${oldProject},'retained','codex','native-session',${running}),
      (${otherChat},${other},${publicAgent},NULL,'public history',NULL,NULL,NULL),
      (${randomUUID()},'foreign',${foreignAgent},NULL,'foreign',NULL,NULL,NULL)`;
  await sql`INSERT INTO chat_threads(id,user_id,agent_id,title)
    SELECT gen_random_uuid(),${owner},${privateAgent},'scale fixture' FROM generate_series(1,11065)`;
  await sql`INSERT INTO workflow_automations(id,org_id,workflow_id,owner_user_id,kind,schedule_type,interval_seconds,enabled,next_run_at)
    VALUES(${kept},${org},${second},${owner},'schedule','loop',900,true,'2026-11-12 10:00'),
      (${disabled},${org},${second},${owner},'schedule','loop',1800,false,NULL),
      (${invalid},${org},${workflow},${other},'schedule','loop',900,true,'2026-11-12 10:00')`;
  await sql`INSERT INTO workflow_user_automation_threads(id,org_id,user_id,workflow_id,chat_thread_id)
    VALUES(${binding},${org},${owner},${second},${chat}),(${randomUUID()},${org},${other},${workflow},${otherChat})`;
  await sql`INSERT INTO agent_runs(id,user_id,org_id,agent_id,chat_thread_id,status,prompt,trigger_source,autonomy_budget,workflow_automation_id)
    VALUES(${running},${owner},${org},${privateAgent},${chat},'running','running prompt','web',0,NULL),
      (${pending},${owner},${org},${privateAgent},NULL,'pending','pending Automation','automation',0,${kept}),
      (${historical},${other},${org},${privateAgent},${otherChat},'completed','history','automation',0,${invalid})`;
  await sql`INSERT INTO active_agent_runs(run_id,org_id,user_id,chat_thread_id,last_heartbeat_at)
    VALUES(${running},${org},${owner},${chat},'2026-11-12 09:00'),(${pending},${org},${owner},NULL,'2026-11-12 09:00')`;
  const contextId = randomUUID();
  await sql`INSERT INTO chat_automation_context(id,chat_thread_id,automation_id,workflow_name,event_type,event_payload)
    VALUES(${contextId},${chat},${kept},'second','schedule','{"scheduledAt":"2026-11-12T10:00:00.000Z"}')`;
  await sql`INSERT INTO chat_events(id,chat_thread_id,seq_id,event_type,context_type,context_id,payload)
    VALUES(${randomUUID()},${chat},1,'input.automation','automation',${contextId},'{"userMessage":{"version":1,"parts":[{"type":"automation","workflowName":"second"}]}}')`;
  await sql`INSERT INTO queued_chat_threads(chat_thread_id,org_id,queued_at) VALUES(${chat},${org},'2026-11-12 09:00')`;
  const before = await preserved();
  const schedules = JSON.stringify(
    Array.from(
      await sql`SELECT to_jsonb(a)-'workflow_id' AS value FROM workflow_automations a WHERE id<>${invalid} ORDER BY id`,
    ),
  );
  const journalBefore =
    await sql`SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`;
  const snapshot = object({ value: chatThreadSnapshotProjectionSchema }).parse(
    (
      await sql`SELECT jsonb_build_object(
    'id',id,'agentId',agent_id,'projectId',project_id,'title',title,
    'sortAt',to_char(last_message_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pinnedAt',pinned_at,'pinOrder',pin_order,'archived',archived,'renamedAt',renamed_at,
    'selectedModel',selected_model,'modelSettings',model_settings) AS value FROM chat_threads WHERE id=${chat}`
    )[0],
  ).value;

  // This collision is checked after copies/relinks/events were attempted: all
  // those writes and the journal must roll back, not merely fail preflight.
  await assert.rejects(
    applyPendingMigrations(sql, { beforeMillis: migration.when + 1 }),
    /Staff Project identity belongs to another owner/u,
  );
  assert.equal(await preserved(), before);
  assert.deepEqual(
    await sql`SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`,
    journalBefore,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM workflows WHERE agent_id=${target}`
    )[0]?.count,
    0,
  );
  assert.equal(
    (await sql`SELECT count(*)::int AS count FROM project_events`)[0]?.count,
    0,
  );
  assert.equal(
    (await sql`SELECT count(*)::int AS count FROM instructions`)[0]?.count,
    1,
  );
  assert.equal(
    (await sql`SELECT count(*)::int AS count FROM workflow_automations`)[0]
      ?.count,
    3,
  );
  assert.equal(
    (
      await sql`SELECT workflow_automation_id FROM agent_runs WHERE id=${historical}`
    )[0]?.workflow_automation_id,
    invalid,
  );
  assert.equal(
    (
      await sql`SELECT switches->'singleAgent' AS value FROM user_feature_switches WHERE org_id=${org} AND user_id=${owner}`
    )[0]?.value,
    false,
  );
  await sql`DELETE FROM projects WHERE id=${collision}`;
  // Exercise this migration's preservation contract independently of later rollouts.
  await applyPendingMigrations(sql, { beforeMillis: migration.when + 1 });
  assert.equal(await preserved(), before);
  const copies =
    await sql`SELECT * FROM workflows WHERE agent_id=${target} ORDER BY name`;
  assert.equal(copies.length, 5);
  const copied = copies.find((row) => {
    return row.id === staffWorkflowCopyId(workflow);
  });
  assert.ok(copied);
  uuid().parse(copied.id);
  assert.equal(copied.name, "experiment--wf-original");
  assert.equal(copied.owner_user_id, owner);
  assert.equal(copied.visibility, "private");
  assert.deepEqual(copied.content_bundle, content.descriptor);
  assert.deepEqual(copied.attachments, attachments.descriptor);
  const converted = copies.find((row) => {
    return row.name === "experiment--instruction";
  });
  assert.equal(converted?.instruction, instruction);
  assert.deepEqual(converted?.content_bundle, instructions.descriptor);
  const shared = copies.find((row) => {
    return row.id === staffWorkflowCopyId(publicWorkflow);
  });
  assert.equal(shared?.visibility, "public");
  assert.equal(shared?.owner_user_id, other);
  assert.ok(typeof shared?.name === "string" && shared.name.length <= 64);
  assert.equal(
    (
      await sql`SELECT content FROM instructions WHERE org_id=${org} AND user_id=${owner}`
    )[0]?.content,
    "",
  );
  assert.equal(
    (
      await sql`SELECT content FROM instructions WHERE org_id=${org} AND user_id=${other}`
    )[0]?.content,
    instruction,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM user_feature_switches WHERE org_id=${org} AND switches->'singleAgent'='true'::jsonb`
    )[0]?.count,
    3,
  );
  assert.deepEqual(
    (
      await sql`SELECT switches FROM user_feature_switches WHERE org_id=${org} AND user_id=${owner}`
    )[0]?.switches,
    { singleAgent: true, otherFlag: true },
  );
  assert.equal(
    JSON.stringify(
      Array.from(
        await sql`SELECT to_jsonb(a)-'workflow_id' AS value FROM workflow_automations a WHERE id<>${invalid} ORDER BY id`,
      ),
    ),
    schedules,
  );
  assert.equal(
    (
      await sql`SELECT workflow_id FROM workflow_automations WHERE id=${kept}`
    )[0]?.workflow_id,
    staffWorkflowCopyId(second),
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM workflow_automations WHERE id=${invalid}`
    )[0]?.count,
    0,
  );
  assert.equal(
    (
      await sql`SELECT workflow_automation_id FROM agent_runs WHERE id=${historical}`
    )[0]?.workflow_automation_id,
    null,
  );
  assert.equal(
    (
      await sql`SELECT workflow_id FROM workflow_user_automation_threads WHERE id=${binding}`
    )[0]?.workflow_id,
    staffWorkflowCopyId(second),
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM workflow_user_automation_threads`
    )[0]?.count,
    1,
  );
  assert.equal(
    (await sql`SELECT agent_id FROM chat_threads WHERE id=${chat}`)[0]
      ?.agent_id,
    target,
  );
  assert.equal(
    (await sql`SELECT project_id FROM chat_threads WHERE id=${chat}`)[0]
      ?.project_id,
    collision,
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT name FROM projects WHERE org_id=${org} AND id<>${oldProject} ORDER BY name`,
    ),
    [{ name: "Ada (0300e951)" }, { name: "Ada (06ba1ce5)" }],
  );
  const events = array(object({ value: chatThreadEventSchema })).parse(
    await sql`SELECT jsonb_build_object(
    'id',id,'seqId',seq_id,'kind',kind,'chatThreadId',chat_thread_id,'agentId',agent_id,
    'projectId',project_id,'title',title,'pinOrder',pin_order,
    'createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    || CASE WHEN reassigned_agent_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reassignedAgentId',reassigned_agent_id) END AS value
    FROM chat_thread_events WHERE chat_thread_id=${chat} ORDER BY seq_id`,
  );
  const replay = replayChatThreadEvents(
    [snapshot],
    events.map((row) => {
      return row.value;
    }),
  );
  assert.equal(replay[0]?.agentId, target);
  assert.equal(replay[0]?.projectId, collision);
  const counts = async () => {
    return JSON.stringify(
      Array.from(
        await sql`SELECT
    (SELECT count(*) FROM workflows) AS workflows,(SELECT count(*) FROM projects) AS projects,
    (SELECT count(*) FROM project_events) AS project_events,(SELECT count(*) FROM chat_thread_events) AS chat_events,
    (SELECT count(*) FROM workflow_automations) AS automations`,
      ),
    );
  };
  const committed = await counts();
  await applyPendingMigrations(sql, { beforeMillis: migration.when + 1 });
  assert.equal(await counts(), committed);
  assert.equal(await preserved(), before);
  console.log(
    "Staff SQL copy: atomic rollback, immutable content, 11067 live Chats, active/pending/queued preservation, metadata replay, Automation identity, other-org isolation and retry passed",
  );
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
}
