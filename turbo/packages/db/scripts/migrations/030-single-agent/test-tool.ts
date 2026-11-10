import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { array, boolean, literal, number, object, string } from "zod";
import { applyPendingMigrations } from "../../migration-runner";
import { parseSnapshot, type Snapshot } from "./snapshot";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(
  databaseUrl,
  "DATABASE_URL is required; tests create a disposable database",
);
const databaseName = `single_agent_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const testUrl = new URL(databaseUrl);
testUrl.pathname = `/${databaseName}`;
const sql = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
const directory = await mkdtemp(join(tmpdir(), "single-agent-test-"));
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const org = `org-${randomUUID()}`;
const otherOrg = `other-${randomUUID()}`;
const owner = "member-owner";
const administrator = "admin-owner";
const defaultAgent = randomUUID();
const oldAgent = randomUUID();
const otherAgent = randomUUID();
const workflow = randomUUID();
const publicWorkflow = randomUUID();
const foreignWorkflow = randomUUID();
const priorProject = randomUUID();
const canary = "private-source-body-must-never-appear-in-reports";
const bundle = { sha256: "a".repeat(64), archiveBytes: 123 };

const planSchema = object({
  executable: literal(false),
  inventorySha256: string(),
  summary: object({
    workflowMoves: number(),
    instructionConversions: number(),
    personalInitializations: number(),
    personalValuesPreserved: number(),
    projectGroups: number(),
    chatMoves: number(),
    automations: number(),
    enabledAutomations: number(),
  }),
  movedWorkflows: array(
    object({
      targetName: string(),
      permissionChanges: array(object({ userId: string() })),
    }),
  ),
  convertedInstructions: array(
    object({ targetName: string(), automaticallyInvoke: literal(false) }),
  ),
  personalInstructions: array(
    object({
      userId: string(),
      action: string(),
      existing: object({ content: object({ bytes: number() }) }).nullable(),
    }),
  ),
  projectGroups: array(
    object({
      owner: string(),
      targetName: string(),
      existingSameNameProjectIds: array(string()),
      chats: array(object({ id: string(), projectId: string().nullable() })),
    }),
  ),
  automations: array(
    object({
      id: string(),
      enabled: boolean(),
      preserveIdentityAndState: literal(true),
    }),
  ),
  automationThreads: array(
    object({ chatThreadId: string().nullable(), owner: string() }),
  ),
  blockers: array(object({ code: string(), key: string() })),
});

function run(
  args: string[],
  expected: number,
  connection = "postgresql://invalid.invalid/offline",
) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, DATABASE_URL: connection },
    },
  );
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  assert.ok(!result.stdout.includes(canary) && !result.stderr.includes(canary));
  return result;
}

async function prepare(snapshot: Snapshot, label: string, expected = 2) {
  const input = join(directory, `${label}-inventory.json`);
  const output = join(directory, `${label}-plan.json`);
  await writeFile(input, JSON.stringify(snapshot), { mode: 0o600 });
  run(
    ["plan", "--org-id", org, "--inventory", input, "--output", output],
    expected,
  );
  const bytes = await readFile(output, "utf8");
  return { output, bytes, result: planSchema.parse(JSON.parse(bytes)) };
}

async function state() {
  return sql`SELECT jsonb_build_object(
    'agents', (SELECT jsonb_agg(to_jsonb(a) || jsonb_build_object('xmin', a.xmin::text) ORDER BY a.id) FROM agents a),
    'metadata', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.org_id) FROM org_metadata o),
    'members', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.org_id, m.user_id) FROM org_members_cache m),
    'instructions', (SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('xmin', i.xmin::text) ORDER BY i.org_id, i.user_id) FROM instructions i),
    'workflows', (SELECT jsonb_agg(to_jsonb(w) || jsonb_build_object('xmin', w.xmin::text) ORDER BY w.id) FROM workflows w),
    'automations', (SELECT jsonb_agg(to_jsonb(a) || jsonb_build_object('xmin', a.xmin::text) ORDER BY a.id) FROM workflow_automations a),
    'automationThreads', (SELECT jsonb_agg(to_jsonb(t) || jsonb_build_object('xmin', t.xmin::text) ORDER BY t.id) FROM workflow_user_automation_threads t),
    'chats', (SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('xmin', c.xmin::text) ORDER BY c.id) FROM chat_threads c),
    'projects', (SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('xmin', p.xmin::text) ORDER BY p.id) FROM projects p)
  ) AS state`;
}

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await applyPendingMigrations(sql);
  await sql`INSERT INTO agents (id, org_id, owner, name, display_name, visibility, instructions, instructions_bundle)
    VALUES (${defaultAgent}, ${org}, ${administrator}, 'okou', 'Okou', 'public', ${canary}, ${sql.json(bundle)}),
      (${oldAgent}, ${org}, ${owner}, 'Research', 'Research Agent', 'private', ${canary}, ${sql.json(bundle)}),
      (${otherAgent}, ${otherOrg}, 'foreign-user', 'foreign-agent', 'Foreign Agent', 'public', ${canary}, ${sql.json(bundle)})`;
  await sql`INSERT INTO org_metadata (org_id, default_agent_id)
    VALUES (${org}, ${defaultAgent}), (${otherOrg}, ${otherAgent})`;
  await sql`INSERT INTO org_members_cache (org_id, user_id, role)
    VALUES (${org}, ${owner}, 'member'), (${org}, ${administrator}, 'admin'),
      (${org}, 'saved-user', 'member'),
      (${otherOrg}, 'foreign-user', 'admin')`;
  await sql`INSERT INTO instructions (org_id, user_id, content, bundle)
    VALUES (${org}, ${owner}, '', ${sql.json(bundle)}),
      (${org}, 'saved-user', ${canary}, ${sql.json(bundle)}),
      (${otherOrg}, 'foreign-user', ${canary}, ${sql.json(bundle)})`;
  await sql`INSERT INTO workflows (id, org_id, agent_id, name, visibility, instruction, content_bundle, owner_user_id, created_by, updated_by)
    VALUES (${workflow}, ${org}, ${oldAgent}, 'daily', 'private', ${canary}, ${sql.json(bundle)}, ${owner}, ${owner}, ${owner}),
      (${publicWorkflow}, ${org}, ${oldAgent}, 'daily', 'public', ${canary}, ${sql.json(bundle)}, ${owner}, ${owner}, ${owner}),
      (${foreignWorkflow}, ${otherOrg}, ${otherAgent}, 'foreign-workflow', 'public', ${canary}, ${sql.json(bundle)}, 'foreign-user', 'foreign-user', 'foreign-user')`;
  await sql`INSERT INTO workflow_automations (org_id, workflow_id, owner_user_id, kind, schedule_type, interval_seconds, enabled)
    VALUES (${org}, ${workflow}, ${owner}, 'schedule', 'loop', 900, true),
      (${org}, ${workflow}, ${owner}, 'schedule', 'loop', 1800, false),
      (${otherOrg}, ${foreignWorkflow}, 'foreign-user', 'schedule', 'loop', 3600, true)`;
  await sql`INSERT INTO projects (id, org_id, user_id, name)
    VALUES (${priorProject}, ${org}, ${owner}, 'Prior Project'),
      (${randomUUID()}, ${otherOrg}, 'foreign-user', 'Foreign Project')`;
  await sql`INSERT INTO chat_threads (user_id, agent_id, project_id, title)
    VALUES (${owner}, ${oldAgent}, ${priorProject}, ${canary}),
      (${owner}, ${oldAgent}, null, ${canary}),
      (${administrator}, ${oldAgent}, null, ${canary}),
      (${administrator}, ${defaultAgent}, null, ${canary}),
      ('foreign-user', ${otherAgent}, null, ${canary})`;
  const [executionChat] = object({ id: string() })
    .array()
    .parse(
      await sql`SELECT id FROM chat_threads WHERE project_id = ${priorProject}`,
    );
  assert.ok(executionChat);
  await sql`INSERT INTO workflow_user_automation_threads (org_id, workflow_id, user_id, chat_thread_id)
    VALUES (${org}, ${workflow}, ${owner}, ${executionChat.id})`;
  await sql`INSERT INTO workflow_user_automation_threads (org_id, workflow_id, user_id)
    VALUES (${otherOrg}, ${foreignWorkflow}, 'foreign-user')`;
  const before = await state();
  const inventoryFile = join(directory, "inventory.json");
  run(
    [
      "inventory",
      "--org-id",
      org,
      "--target",
      "disposable-test",
      "--output",
      inventoryFile,
    ],
    0,
    testUrl.toString(),
  );
  const inventoryBytes = await readFile(inventoryFile);
  assert.ok(!inventoryBytes.includes(canary));
  assert.ok(
    !inventoryBytes.includes("foreign-"),
    "all inventoried tables are org-scoped",
  );
  const snapshot = parseSnapshot(JSON.parse(inventoryBytes.toString("utf8")));
  assert.equal(
    snapshot.readOnly,
    true,
    "Postgres confirms read-only execution",
  );
  assert.equal(snapshot.agents.length, 2);
  assert.equal(snapshot.chats.length, 4);
  assert.equal((await stat(inventoryFile)).mode & 0o777, 0o600);

  const output = join(directory, "plan.json");
  run(
    ["plan", "--org-id", org, "--inventory", inventoryFile, "--output", output],
    2,
  );
  const planned = planSchema.parse(JSON.parse(await readFile(output, "utf8")));
  assert.deepEqual(planned.summary, {
    workflowMoves: 2,
    instructionConversions: 1,
    personalInitializations: 1,
    personalValuesPreserved: 2,
    projectGroups: 2,
    chatMoves: 3,
    automations: 2,
    enabledAutomations: 1,
  });
  assert.equal(
    planned.inventorySha256,
    createHash("sha256").update(inventoryBytes).digest("hex"),
  );
  assert.deepEqual(
    planned.movedWorkflows.map((row) => {
      return row.targetName;
    }),
    ["research--wf-daily", "research--wf-daily"],
  );
  assert.equal(
    planned.convertedInstructions[0]?.targetName,
    "research--instruction",
  );
  assert.ok(
    !planned.blockers.some((row) => {
      return row.code === "TargetNameCollision";
    }),
    "private override shares the public workflow's name",
  );
  assert.ok(
    planned.blockers.some((row) => {
      return row.code === "WorkflowRightsChange";
    }),
    "visibility expansion and lost publish rights block migration",
  );
  assert.equal(
    planned.personalInstructions.find((row) => {
      return row.userId === owner;
    })?.existing?.content.bytes,
    0,
  );
  assert.equal(
    planned.personalInstructions.find((row) => {
      return row.userId === owner;
    })?.action,
    "preserve",
  );
  assert.equal(
    planned.personalInstructions.find((row) => {
      return row.userId === "saved-user";
    })?.action,
    "preserve",
    "content equal to the public default never proves automatic seed provenance",
  );
  assert.equal(
    planned.personalInstructions.find((row) => {
      return row.userId === administrator;
    })?.action,
    "initialize-once",
  );
  assert.deepEqual(
    new Set(
      planned.projectGroups.map((row) => {
        return row.owner;
      }),
    ),
    new Set([owner, administrator]),
  );
  assert.ok(
    planned.projectGroups.every((row) => {
      return row.targetName === "Research Agent";
    }),
  );
  assert.equal(
    planned.projectGroups
      .flatMap((row) => {
        return row.chats;
      })
      .filter((row) => {
        return row.projectId === priorProject;
      }).length,
    1,
  );
  assert.deepEqual(
    planned.automations
      .map((row) => {
        return row.enabled;
      })
      .sort(),
    [false, true],
  );
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(planned.automationThreads, [
    { chatThreadId: executionChat.id, owner },
  ]);
  const secondOutput = join(directory, "repeat.json");
  run(
    [
      "plan",
      "--org-id",
      org,
      "--inventory",
      inventoryFile,
      "--output",
      secondOutput,
    ],
    2,
  );
  assert.equal(
    await readFile(secondOutput, "utf8"),
    await readFile(output, "utf8"),
  );

  const collision = structuredClone(snapshot);
  const source = collision.agents.find((row) => {
    return row.id === oldAgent;
  });
  assert.ok(source);
  source.name = "x".repeat(60);
  source.displayName = "x".repeat(121);
  const tooLong = await prepare(collision, "overlong");
  assert.ok(
    tooLong.result.blockers.some((row) => {
      return row.code === "InvalidTargetWorkflowName";
    }),
  );
  assert.ok(
    tooLong.result.blockers.some((row) => {
      return row.code === "InvalidTargetProjectName";
    }),
  );
  assert.equal(
    tooLong.result.convertedInstructions[0]?.targetName,
    `${source.name}--instruction`,
    "never truncate",
  );

  const duplicate = structuredClone(snapshot);
  const old = duplicate.agents.find((row) => {
    return row.id === oldAgent;
  });
  assert.ok(old);
  const caseAgent = randomUUID();
  duplicate.agents.push({ ...old, id: caseAgent, name: "RESEARCH" });
  const originalChat = duplicate.chats.find((row) => {
    return row.owner === owner;
  });
  assert.ok(originalChat);
  duplicate.chats.push({
    ...originalChat,
    id: randomUUID(),
    agentId: caseAgent,
  });
  const existing = duplicate.projects.find((row) => {
    return row.id === priorProject;
  });
  assert.ok(existing);
  existing.name = "Research Agent";
  const defaultCollision = duplicate.workflows[0];
  assert.ok(defaultCollision);
  duplicate.workflows.push({
    ...defaultCollision,
    id: randomUUID(),
    agentId: defaultAgent,
    name: "research--wf-daily",
  });
  const conflicts = await prepare(duplicate, "collisions");
  assert.ok(
    conflicts.result.blockers.some((row) => {
      return row.code === "TargetNameCollision";
    }),
  );
  assert.ok(
    conflicts.result.blockers.some((row) => {
      return row.code === "ExistingProjectNameCollision";
    }),
  );
  assert.ok(
    conflicts.result.blockers.some((row) => {
      return row.code === "TargetProjectNameCollision";
    }),
  );
  assert.deepEqual(
    conflicts.result.projectGroups.find((row) => {
      return row.owner === owner;
    })?.existingSameNameProjectIds,
    [priorProject],
  );

  const clean = structuredClone(snapshot);
  clean.workflows = clean.workflows.filter((row) => {
    return row.id !== publicWorkflow;
  });
  const member = clean.members.find((row) => {
    return row.userId === owner;
  });
  assert.ok(member);
  member.role = "admin";
  const cleanPlan = await prepare(clean, "no-detected-blockers", 0);
  assert.equal(cleanPlan.result.blockers.length, 0);
  assert.equal(
    cleanPlan.result.executable,
    false,
    "absence of detected blockers never authorizes apply",
  );

  const rejectedFile = join(directory, "rejected.json");
  run(
    [
      "plan",
      "--org-id",
      otherOrg,
      "--inventory",
      inventoryFile,
      "--output",
      rejectedFile,
    ],
    1,
  );
  await assert.rejects(stat(rejectedFile), { code: "ENOENT" });
  const malformed = join(directory, "duplicate.json");
  await writeFile(
    malformed,
    JSON.stringify({
      ...snapshot,
      agents: [...snapshot.agents, snapshot.agents[0]],
    }),
  );
  run(
    [
      "plan",
      "--org-id",
      org,
      "--inventory",
      malformed,
      "--output",
      rejectedFile,
    ],
    1,
  );
  await assert.rejects(stat(rejectedFile), { code: "ENOENT" });
  run(
    [
      "inventory",
      "--org-id",
      otherOrg + "-missing",
      "--target",
      "test",
      "--output",
      rejectedFile,
    ],
    1,
    testUrl.toString(),
  );
  run(
    [
      "plan",
      "--org-id",
      org,
      "--inventory",
      inventoryFile,
      "--output",
      output,
      "--migrate",
    ],
    1,
  );
  run(
    ["plan", "--org-id", org, "--inventory", inventoryFile, "--output", output],
    1,
  );
  assert.equal(
    await readFile(output, "utf8"),
    await readFile(secondOutput, "utf8"),
    "existing report cannot be overwritten",
  );
  assert.deepEqual(
    await state(),
    before,
    "inventory and all plans preserve full source rows and revisions",
  );
  console.log(
    "Single Agent preparation: tenant isolation, read-only inventory, offline deterministic plans, permissions, personal empty values, private Projects, enabled/disabled Automations and fail-closed conflicts passed",
  );
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
