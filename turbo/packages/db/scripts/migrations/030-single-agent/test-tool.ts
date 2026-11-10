import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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
let proxy: ReturnType<typeof spawn> | undefined;
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
const rightsSchema = object({
  view: boolean(),
  manage: boolean(),
  publish: boolean(),
});

const planSchema = object({
  format: literal("single-agent-plan-v3"),
  executable: literal(false),
  privateAgentWorkflowPolicy: literal("private-preserve-workflow-owner"),
  inventorySha256: string(),
  agentPrefixes: object({
    format: literal("single-agent-prefixes-v1"),
    orgId: string(),
    prefixes: array(object({ agentId: string(), prefix: string() })),
  }),
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
      targetOwner: string(),
      targetVisibility: string(),
      source: object({ id: string(), owner: string(), visibility: string() }),
      permissionChanges: array(
        object({
          userId: string(),
          before: rightsSchema,
          after: rightsSchema,
          acceptedChanges: array(string()),
          unresolvedChanges: array(string()),
        }),
      ),
    }),
  ),
  convertedInstructions: array(
    object({
      targetName: string(),
      owner: string(),
      visibility: string(),
      automaticallyInvoke: literal(false),
      maintenanceChanges: array(string()),
    }),
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
      sourceAgentId: string(),
      targetName: string(),
      existingSameNameProjectIds: array(string()),
      chats: array(object({ id: string(), projectId: string().nullable() })),
    }),
  ),
  automations: array(
    object({
      id: string(),
      owner: string(),
      workflowId: string(),
      enabled: boolean(),
      workflowAccess: object({ before: boolean(), after: boolean() }),
      preserveIdentityAndState: literal(true),
    }),
  ),
  automationThreads: array(
    object({
      chatThreadId: string().nullable(),
      owner: string(),
      workflowAccess: object({ before: boolean(), after: boolean() }),
    }),
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
  proxy = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./test-startup-proxy.ts", import.meta.url)),
      testUrl.hostname,
      testUrl.port || "5432",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  assert.ok(proxy.stdout);
  const ready = await Promise.race([
    once(proxy.stdout, "data"),
    once(proxy, "exit").then(() => {
      throw new Error("Startup proxy exited before readiness");
    }),
  ]);
  const proxyAddress = object({ port: number().int().positive() }).parse(
    JSON.parse(String(ready[0])),
  );
  const proxyUrl = new URL(testUrl);
  proxyUrl.hostname = "127.0.0.1";
  proxyUrl.port = String(proxyAddress.port);
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
    proxyUrl.toString(),
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
    ["research-age--wf-daily", "research-age--wf-daily"],
  );
  assert.equal(
    planned.convertedInstructions[0]?.targetName,
    "research-age--instruction",
  );
  assert.ok(
    !planned.blockers.some((row) => {
      return row.code === "TargetNameCollision";
    }),
    "same-source overrides keep their typed name",
  );
  assert.ok(
    planned.blockers.some((row) => {
      return row.code === "TargetWorkflowScopeCollision";
    }),
    "privatizing a public override must not collide with its same-owner private Workflow",
  );
  assert.ok(
    planned.blockers.some((row) => {
      return row.code === "WorkflowRightsChange";
    }),
    "unapproved publish-right changes still block migration",
  );
  const privateMove = planned.movedWorkflows.find((row) => {
    return row.source.id === workflow;
  });
  const publicMove = planned.movedWorkflows.find((row) => {
    return row.source.id === publicWorkflow;
  });
  assert.ok(privateMove && publicMove);
  assert.ok(
    planned.movedWorkflows.every((row) => {
      return row.targetVisibility === "private" && row.targetOwner === owner;
    }),
    "all Workflows from private Agents become private without changing owner",
  );
  assert.equal(planned.convertedInstructions[0]?.owner, owner);
  assert.equal(planned.convertedInstructions[0]?.visibility, "private");
  assert.deepEqual(
    privateMove.permissionChanges,
    [
      {
        userId: owner,
        before: { view: true, manage: true, publish: true },
        after: { view: true, manage: true, publish: false },
        acceptedChanges: [],
        unresolvedChanges: ["publish"],
      },
    ],
    "private Workflow owner loses publish permission on the public default host",
  );
  assert.deepEqual(
    publicMove.permissionChanges,
    [],
    "a formerly public Workflow on a private Agent does not expose content to other members or admins",
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
    {
      chatThreadId: executionChat.id,
      owner,
      workflowAccess: { before: true, after: true },
    },
  ]);
  for (const automation of planned.automations) {
    assert.equal(automation.owner, owner);
    assert.equal(automation.workflowId, workflow);
    assert.deepEqual(automation.workflowAccess, { before: true, after: true });
  }
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
    !tooLong.result.blockers.some((row) => {
      return row.code === "InvalidTargetWorkflowName";
    }),
    "long display names use bounded prefixes instead of the internal Agent name",
  );
  assert.ok(
    tooLong.result.blockers.some((row) => {
      return row.code === "InvalidTargetProjectName";
    }),
  );
  assert.equal(
    tooLong.result.convertedInstructions[0]?.targetName,
    `${"x".repeat(12)}--instruction`,
    "the prefix is bounded to twelve characters",
  );

  const longWorkflows = structuredClone(snapshot);
  for (const row of longWorkflows.workflows) row.name = "x".repeat(64);
  const shortened = await prepare(longWorkflows, "long-workflow-names");
  const longNames = shortened.result.movedWorkflows.map((row) => {
    return row.targetName;
  });
  assert.equal(new Set(longNames).size, 1);
  assert.ok(
    longNames.every((name) => {
      return name.length <= 64;
    }),
  );
  assert.ok(longNames[0]?.match(/^research-age--wf-x+-[a-f0-9]{8}$/u));
  assert.ok(
    !shortened.result.blockers.some((row) => {
      return row.code === "InvalidTargetWorkflowName";
    }),
    "long Workflow names retain their same-source override relationship with a stable suffix",
  );
  const distinctLong = structuredClone(longWorkflows);
  for (const row of distinctLong.workflows)
    row.name = "x".repeat(63) + (row.id === workflow ? "a" : "b");
  const distinctShortened = await prepare(
    distinctLong,
    "distinct-long-workflow-names",
  );
  assert.equal(
    new Set(
      distinctShortened.result.movedWorkflows.map((row) => {
        return row.targetName;
      }),
    ).size,
    2,
    "different long Workflow names with the same visible stem keep distinct target names",
  );

  const renamed = structuredClone(snapshot);
  const renamedAgent = renamed.agents.find((row) => {
    return row.id === oldAgent;
  });
  assert.ok(renamedAgent);
  renamedAgent.displayName = "Research (new label)";
  const frozenPrefixes = join(directory, "fixed-prefixes.json");
  await writeFile(frozenPrefixes, JSON.stringify(planned.agentPrefixes), {
    mode: 0o600,
  });
  const frozenOutput = join(directory, "fixed-prefix-plan.json");
  run(
    [
      "plan",
      "--org-id",
      org,
      "--inventory",
      inventoryFile,
      "--agent-prefixes",
      frozenPrefixes,
      "--output",
      frozenOutput,
    ],
    2,
  );
  assert.equal(
    await readFile(frozenOutput, "utf8"),
    await readFile(output, "utf8"),
    "reusing the complete embedded prefix map produces identical plan bytes",
  );
  const renamedInventory = join(directory, "renamed-inventory.json");
  const renamedOutput = join(directory, "renamed-fixed-plan.json");
  await writeFile(renamedInventory, JSON.stringify(renamed), { mode: 0o600 });
  run(
    [
      "plan",
      "--org-id",
      org,
      "--inventory",
      renamedInventory,
      "--agent-prefixes",
      frozenPrefixes,
      "--output",
      renamedOutput,
    ],
    2,
  );
  assert.deepEqual(
    planSchema
      .parse(JSON.parse(await readFile(renamedOutput, "utf8")))
      .movedWorkflows.map((row) => {
        return row.targetName;
      }),
    planned.movedWorkflows.map((row) => {
      return row.targetName;
    }),
    "a fixed prefix map is not silently regenerated from changed display names",
  );

  const nonLatin = structuredClone(snapshot);
  const nonLatinAgent = nonLatin.agents.find((row) => {
    return row.id === oldAgent;
  });
  assert.ok(nonLatinAgent);
  nonLatinAgent.displayName = "研究助手";
  const unicodePlan = await prepare(nonLatin, "non-latin-name");
  assert.equal(
    unicodePlan.result.agentPrefixes.prefixes[0]?.prefix,
    `a-${oldAgent.replaceAll("-", "").slice(0, 8)}`,
  );
  const englishPrefixes = {
    ...unicodePlan.result.agentPrefixes,
    prefixes: [{ agentId: oldAgent, prefix: "research" }],
  };
  await writeFile(frozenPrefixes, JSON.stringify(englishPrefixes));
  const unicodeInventory = join(directory, "non-latin-name-inventory.json");
  const englishOutput = join(directory, "english-prefix-plan.json");
  run(
    [
      "plan",
      "--org-id",
      org,
      "--inventory",
      unicodeInventory,
      "--agent-prefixes",
      frozenPrefixes,
      "--output",
      englishOutput,
    ],
    2,
  );
  assert.equal(
    planSchema.parse(JSON.parse(await readFile(englishOutput, "utf8")))
      .convertedInstructions[0]?.targetName,
    "research--instruction",
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
  existing.name = `Research Agent (${oldAgent.replaceAll("-", "").slice(0, 8)})`;
  const defaultCollision = duplicate.workflows[0];
  assert.ok(defaultCollision);
  duplicate.workflows.push({
    ...defaultCollision,
    id: randomUUID(),
    agentId: defaultAgent,
    name: `res-${oldAgent.replaceAll("-", "").slice(0, 8)}--wf-daily`,
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
    !conflicts.result.blockers.some((row) => {
      return row.code === "TargetProjectNameCollision";
    }),
    "same-name source Agents receive separate Project labels with source IDs",
  );
  assert.deepEqual(
    conflicts.result.projectGroups.find((row) => {
      return row.owner === owner && row.sourceAgentId === oldAgent;
    })?.existingSameNameProjectIds,
    [priorProject],
  );
  assert.equal(
    new Set(
      conflicts.result.agentPrefixes.prefixes.map((row) => {
        return row.prefix;
      }),
    ).size,
    2,
  );
  assert.ok(
    conflicts.result.agentPrefixes.prefixes.every((row) => {
      return row.prefix.length <= 12;
    }),
  );
  assert.ok(
    conflicts.result.projectGroups.every((row) => {
      return (
        row.targetName ===
        `Research Agent (${row.sourceAgentId.replaceAll("-", "").slice(0, 8)})`
      );
    }),
  );

  const malformedPrefixesOutput = join(directory, "bad-prefixes-plan.json");
  for (const badPrefixes of [
    { ...planned.agentPrefixes, orgId: otherOrg },
    { ...planned.agentPrefixes, prefixes: [] },
    {
      ...planned.agentPrefixes,
      prefixes: [{ agentId: otherAgent, prefix: "foreign" }],
    },
    {
      ...planned.agentPrefixes,
      prefixes: [{ agentId: oldAgent, prefix: "UPPER" }],
    },
    {
      ...planned.agentPrefixes,
      prefixes: [{ agentId: oldAgent, prefix: "x".repeat(13) }],
    },
    {
      ...planned.agentPrefixes,
      prefixes: [
        ...planned.agentPrefixes.prefixes,
        ...planned.agentPrefixes.prefixes,
      ],
    },
  ]) {
    await writeFile(frozenPrefixes, JSON.stringify(badPrefixes));
    run(
      [
        "plan",
        "--org-id",
        org,
        "--inventory",
        inventoryFile,
        "--agent-prefixes",
        frozenPrefixes,
        "--output",
        malformedPrefixesOutput,
      ],
      1,
    );
    await assert.rejects(stat(malformedPrefixesOutput), { code: "ENOENT" });
  }
  await writeFile(
    frozenPrefixes,
    JSON.stringify({
      ...conflicts.result.agentPrefixes,
      prefixes: conflicts.result.agentPrefixes.prefixes.map((row) => {
        return {
          ...row,
          prefix: "same",
        };
      }),
    }),
  );
  run(
    [
      "plan",
      "--org-id",
      org,
      "--inventory",
      join(directory, "collisions-inventory.json"),
      "--agent-prefixes",
      frozenPrefixes,
      "--output",
      malformedPrefixesOutput,
    ],
    1,
  );
  await assert.rejects(stat(malformedPrefixesOutput), { code: "ENOENT" });

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
  const publicSource = structuredClone(snapshot);
  const sharedAgent = publicSource.agents.find((row) => {
    return row.id === oldAgent;
  });
  assert.ok(sharedAgent);
  sharedAgent.visibility = "public";
  const maintenance = await prepare(publicSource, "instruction-maintenance");
  assert.deepEqual(
    maintenance.result.convertedInstructions[0]?.maintenanceChanges,
    [owner],
  );
  assert.ok(
    maintenance.result.blockers.some((row) => {
      return row.code === "InstructionWorkflowRightsChange";
    }),
    "a former public Agent owner cannot silently lose Instruction maintenance rights",
  );
  assert.equal(
    maintenance.result.movedWorkflows.find((row) => {
      return row.source.id === publicWorkflow;
    })?.targetVisibility,
    "public",
    "public-Agent Workflows keep their existing visibility",
  );
  assert.ok(
    !maintenance.result.blockers.some((row) => {
      return row.code === "TargetWorkflowScopeCollision";
    }),
    "public/private overrides retain separate scopes on public Agents",
  );
  const differentOwner = structuredClone(snapshot);
  const separatelyOwned = differentOwner.workflows.find((row) => {
    return row.id === workflow;
  });
  assert.ok(separatelyOwned);
  separatelyOwned.owner = administrator;
  const ownerAccess = await prepare(
    differentOwner,
    "workflow-owner-on-private-host",
  );
  assert.deepEqual(
    ownerAccess.result.movedWorkflows.find((row) => {
      return row.source.id === workflow;
    })?.permissionChanges,
    [
      {
        userId: administrator,
        before: { view: true, manage: true, publish: false },
        after: { view: true, manage: true, publish: true },
        acceptedChanges: [],
        unresolvedChanges: ["publish"],
      },
    ],
    "Workflow owners retain view/manage rights even when a different user owns the private host",
  );
  assert.equal(
    ownerAccess.result.movedWorkflows.find((row) => {
      return row.source.id === workflow;
    })?.targetOwner,
    administrator,
    "the private Agent owner never acquires another member's private Workflow",
  );

  const privacy = structuredClone(snapshot);
  const privacyAgent = privacy.agents.find((row) => {
    return row.id === oldAgent;
  });
  assert.ok(privacyAgent);
  privacyAgent.owner = administrator;
  privacy.workflows = privacy.workflows.filter((row) => {
    return row.id === publicWorkflow;
  });
  privacy.automations = [];
  privacy.automationThreads = [];
  const narrowed = await prepare(privacy, "accepted-private-access", 0);
  assert.equal(narrowed.result.blockers.length, 0);
  assert.deepEqual(narrowed.result.movedWorkflows[0]?.permissionChanges, [
    {
      userId: administrator,
      before: { view: true, manage: true, publish: false },
      after: { view: false, manage: false, publish: false },
      acceptedChanges: ["view", "manage"],
      unresolvedChanges: [],
    },
    {
      userId: owner,
      before: { view: true, manage: false, publish: false },
      after: { view: true, manage: true, publish: false },
      acceptedChanges: ["manage"],
      unresolvedChanges: [],
    },
  ]);

  const automationAccess = structuredClone(snapshot);
  const formerlyShared = automationAccess.workflows.find((row) => {
    return row.id === publicWorkflow;
  });
  assert.ok(formerlyShared);
  formerlyShared.owner = administrator;
  for (const automation of automationAccess.automations) {
    automation.workflowId = publicWorkflow;
  }
  for (const thread of automationAccess.automationThreads) {
    thread.workflowId = publicWorkflow;
  }
  const brokenAccess = await prepare(
    automationAccess,
    "automation-access-loss",
  );
  assert.equal(
    brokenAccess.result.blockers.filter((row) => {
      return row.code === "AutomationOwnerCannotAccessTargetWorkflow";
    }).length,
    2,
    "both enabled and disabled Automations block when their unchanged owner loses access",
  );
  assert.ok(
    brokenAccess.result.blockers.some((row) => {
      return row.code === "AutomationThreadOwnerCannotAccessTargetWorkflow";
    }),
    "execution Chat bindings cannot retain a now-inaccessible Workflow",
  );
  for (const automation of brokenAccess.result.automations) {
    assert.equal(automation.owner, owner);
    assert.deepEqual(automation.workflowAccess, { before: true, after: false });
  }
  assert.ok(
    !brokenAccess.result.blockers.some((row) => {
      return row.code === "TargetWorkflowScopeCollision";
    }),
    "same-name private Workflows with different owners remain separate valid scopes",
  );

  const rejectedFile = join(directory, "rejected.json");
  run(
    [
      "plan",
      "--org-id",
      org,
      "--inventory",
      inventoryFile,
      "--agent-prefixes",
      "",
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
      org,
      "--target",
      "test",
      "--agent-prefixes",
      frozenPrefixes,
      "--output",
      rejectedFile,
    ],
    1,
  );
  await assert.rejects(stat(rejectedFile), { code: "ENOENT" });
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
  if (proxy?.pid && proxy.exitCode === null && proxy.signalCode === null) {
    const closed = once(proxy, "exit");
    proxy.kill();
    await closed;
  }
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
