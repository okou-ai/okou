import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createConnection,
  createServer as createTcpServer,
  type Socket,
} from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import postgres from "postgres";
import { array, object, string } from "zod";
import {
  prepareContentBundle,
  contentBundleDigest,
  contentBundleKey,
  readContentBundle,
} from "@okouai/core/content-bundle";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { prepareWorkflowAttachmentBundle } from "@okouai/core/workflow-attachment-bundle";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
} from "@okouai/api-contracts/contracts/chat-threads";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { applyPendingMigrations } from "../../migration-runner";

const connection = process.env.DATABASE_URL;
assert.ok(connection, "Disposable DATABASE_URL required");
const address = new URL(connection);
assert.ok(["127.0.0.1", "localhost", "postgres"].includes(address.hostname));
const database = `single_agent_execute_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(connection, { max: 1, onnotice: () => {} });
const testUrl = new URL(connection);
testUrl.pathname = `/${database}`;
const sql = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
const directory = await mkdtemp(join(tmpdir(), "single-agent-execute-"));
const org = `org-${randomUUID()}`,
  foreignOrg = `foreign-${randomUUID()}`;
const owner = "private-agent-owner",
  other = "different-workflow-owner",
  administrator = "workspace-admin";
const target = randomUUID(),
  privateAgent = randomUUID(),
  publicAgent = randomUUID(),
  foreignAgent = randomUUID();
const workflow = randomUUID(),
  retainedWorkflow = randomUUID(),
  publicWorkflow = randomUUID();
const chat = randomUUID(),
  otherChat = randomUUID(),
  originalProject = randomUUID();
const nativeRun = randomUUID();
const badAutomation = randomUUID(),
  keptAutomation = randomUUID(),
  disabledAutomation = randomUUID(),
  binding = randomUUID(),
  historicalRun = randomUUID();
const canary = "source-private-content-must-not-appear-in-console";
const defaultText = `  public default\r\n${canary}\n`;
const objects = new Map<string, Buffer>();
const sockets = new Set<Socket>();
const serverErrors: unknown[] = [];
let puts = 0;
let dropWriteResponse = false;
const describedFields: string[] = [];
let blockUpload: { reached: () => void; released: Promise<void> } | undefined;
let releasePendingUpload: (() => void) | undefined;
let pendingApply: ReturnType<typeof invoke> | undefined;

async function handle(request: IncomingMessage, response: ServerResponse) {
  const key = decodeURIComponent(
    new URL(request.url ?? "/", "http://fixture.test").pathname,
  ).replace(/^\/copy\//u, "");
  if (request.method === "GET") {
    const value = objects.get(key);
    if (!value) {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    response.writeHead(200, { "content-length": value.length });
    response.end(value);
    return;
  }
  if (request.method === "PUT") {
    if (blockUpload) {
      const blocked = blockUpload;
      blockUpload = undefined;
      blocked.reached();
      await blocked.released;
    }
    if (objects.has(key) && request.headers["if-none-match"] === "*") {
      response.writeHead(412, { "content-type": "application/xml" });
      response.end("<Error><Code>PreconditionFailed</Code></Error>");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
    puts++;
    response.writeHead(200, { ETag: '"fixture"' });
    response.end();
    return;
  }
  throw new Error("Unhandled fixture request");
}
const store = createHttpServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    serverErrors.push(error);
    response.writeHead(500);
    response.end();
  });
});

// Real PostgreSQL executes the statement. Only its committed response is lost.
const proxy = createTcpServer((downstream) => {
  const upstream = createConnection({
    host: testUrl.hostname,
    port: Number(testUrl.port || "5432"),
  });
  sockets.add(downstream);
  sockets.add(upstream);
  let buffered = Buffer.alloc(0),
    swallowing = false,
    writeResult = false;
  downstream.pipe(upstream);
  upstream.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 5) {
      const length = buffered.readUInt32BE(1) + 1;
      if (buffered.length < length) break;
      const frame = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      if (frame[0] === 84) {
        const field = frame.subarray(7, frame.indexOf(0, 7)).toString("utf8");
        writeResult = field === "written";
        if (dropWriteResponse) describedFields.push(field);
      }
      // Describe can precede execution. Wait for its actual result row before
      // withholding anything, then close only at the committed ReadyForQuery.
      if (frame[0] === 68 && writeResult && dropWriteResponse)
        swallowing = true;
      if (swallowing && frame[0] === 90) {
        dropWriteResponse = false;
        downstream.destroy();
        upstream.destroy();
        return;
      }
      if (!swallowing) downstream.write(frame);
    }
  });
  for (const socket of [downstream, upstream]) {
    socket.on("error", () => {
      downstream.destroy();
      upstream.destroy();
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  }
  downstream.on("close", () => {
    return upstream.destroy();
  });
  upstream.on("end", () => {
    return downstream.end();
  });
});

async function listen(
  server:
    ReturnType<typeof createHttpServer> | ReturnType<typeof createTcpServer>,
) {
  await new Promise<void>((resolve) => {
    return server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = server.address();
  assert.ok(endpoint && typeof endpoint !== "string");
  return endpoint.port;
}

const cli = fileURLToPath(new URL("./execute.ts", import.meta.url));
const preparationCli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const execute = promisify(execFile);
let environment: NodeJS.ProcessEnv;
async function invoke(args: string[], successful = true, path = cli) {
  let result;
  try {
    result = await execute(
      process.execPath,
      ["--import", "tsx", path, ...args],
      { env: environment, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (error) {
    if (successful) throw error;
    assert.ok(
      error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string",
    );
    assert.ok(!error.stderr.includes(canary));
    return { stdout: "", stderr: error.stderr };
  }
  assert.ok(!result.stdout.includes(canary) && !result.stderr.includes(canary));
  assert.equal(
    successful,
    true,
    `command unexpectedly succeeded: ${result.stdout}; database fields: ${describedFields.join(",")}`,
  );
  return result;
}

const observedTables = [
  "agents",
  "org_metadata",
  "org_members_cache",
  "workflows",
  "instructions",
  "projects",
  "chat_threads",
  "workflow_automations",
  "workflow_user_automation_threads",
  "agent_runs",
  "workflow_schedule_skips",
];
async function dataState() {
  const result: Record<string, string> = {};
  for (const name of observedTables) {
    const rows = await sql.unsafe(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS value FROM "${name}" t`,
    );
    result[name] = object({ value: string() }).parse(rows[0]).value;
  }
  return result;
}
async function eventsState() {
  const result = await sql`SELECT jsonb_build_object(
    'projects',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM project_events e),
    'chats',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM chat_thread_events e),
    'projectSeq',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY user_id),'[]'::jsonb) FROM project_event_sequences e),
    'chatSeq',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY user_id),'[]'::jsonb) FROM chat_thread_event_sequences e)
  )::text AS value`;
  return object({ value: string() }).parse(result[0]).value;
}

try {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await applyPendingMigrations(sql);
  const storePort = await listen(store),
    proxyPort = await listen(proxy);
  const proxied = new URL(testUrl);
  proxied.hostname = "127.0.0.1";
  proxied.port = String(proxyPort);
  const credentialFile = join(directory, "database-url");
  await writeFile(credentialFile, proxied.toString(), { mode: 0o600 });
  environment = {
    ...process.env,
    DATABASE_URL: testUrl.toString(),
    DATABASE_URL_FILE: credentialFile,
    R2_ENDPOINT: `http://127.0.0.1:${storePort}`,
    R2_USER_STORAGES_BUCKET_NAME: "copy",
    R2_ACCESS_KEY_ID: "fixture",
    R2_SECRET_ACCESS_KEY: "fixture",
  };
  const emptyConnection = join(directory, "empty-database-url");
  await writeFile(emptyConnection, "", { mode: 0o600 });
  environment.DATABASE_URL_FILE = emptyConnection;
  try {
    const rejected = await invoke(
      [
        "verify",
        "--org-id",
        org,
        "--target",
        "isolated-test-copy",
        "--directory",
        join(directory, "unused"),
        "--expect-image-sha256",
        "0".repeat(64),
      ],
      false,
    );
    assert.match(rejected.stderr, /NonEmptyDatabaseConnectionRequired/u);
  } finally {
    environment.DATABASE_URL_FILE = credentialFile;
  }
  const instructionBundle = await prepareContentBundle([
    { path: "instructions.md", content: Buffer.from(defaultText) },
  ]);
  const emptyPersonal = await prepareContentBundle([
    { path: "instructions.md", content: Buffer.alloc(0) },
  ]);
  const savedPersonal = await prepareContentBundle([
    { path: "instructions.md", content: Buffer.from("saved personal value") },
  ]);
  objects.set(
    contentBundleKey(instructionBundle.descriptor.sha256),
    instructionBundle.archive,
  );
  objects.set(
    contentBundleKey(emptyPersonal.descriptor.sha256),
    emptyPersonal.archive,
  );
  objects.set(
    contentBundleKey(savedPersonal.descriptor.sha256),
    savedPersonal.archive,
  );
  const workflowInstruction = `workflow body\n${canary}`;
  const attachment = await prepareWorkflowAttachmentBundle(org, workflow, [
    {
      path: "scripts/run.sh",
      content: Buffer.from("#!/bin/sh\necho retained\n"),
    },
    { path: "assets/bytes.bin", content: Buffer.from([0, 255, 128]) },
  ]);
  assert.ok(attachment.descriptor.kind === "bundle" && attachment.archive);
  objects.set(attachment.descriptor.objectKey, attachment.archive);
  const sourceBundle = await prepareContentBundle([
    {
      path: "SKILL.md",
      content: Buffer.from(
        synthesizeWorkflowSkillMd({
          name: "original",
          description: "original description",
          instruction: workflowInstruction,
        }),
      ),
    },
    {
      path: "scripts/run.sh",
      mode: 0o755,
      content: Buffer.from("#!/bin/sh\necho retained\n"),
    },
    { path: "assets/bytes.bin", content: Buffer.from([0, 255, 128]) },
  ]);
  const secondBundle = await prepareContentBundle([
    {
      path: "SKILL.md",
      content: Buffer.from(
        synthesizeWorkflowSkillMd({
          name: "second",
          description: null,
          instruction: workflowInstruction,
        }),
      ),
    },
  ]);
  objects.set(
    contentBundleKey(sourceBundle.descriptor.sha256),
    sourceBundle.archive,
  );
  objects.set(
    contentBundleKey(secondBundle.descriptor.sha256),
    secondBundle.archive,
  );
  await sql`INSERT INTO agents(id,org_id,owner,name,display_name,visibility,instructions,instructions_bundle)
    VALUES (${target},${org},${administrator},'okou','Okou','public',${defaultText},${sql.json(instructionBundle.descriptor)}),
      (${privateAgent},${org},${owner},'private-ada','Ada','private',${defaultText},${sql.json(instructionBundle.descriptor)}),
      (${publicAgent},${org},${administrator},'public-ada','Ada','public',${defaultText},${sql.json(instructionBundle.descriptor)}),
      (${foreignAgent},${foreignOrg},'foreign','foreign','Foreign','public',${defaultText},${sql.json(instructionBundle.descriptor)})`;
  await sql`INSERT INTO org_metadata(org_id,default_agent_id) VALUES(${org},${target}),(${foreignOrg},${foreignAgent})`;
  await sql`INSERT INTO org_members_cache(org_id,user_id,role) VALUES(${org},${owner},'member'),(${org},${other},'member'),(${org},${administrator},'admin'),(${foreignOrg},'foreign','admin')`;
  await sql`INSERT INTO instructions(org_id,user_id,content,bundle) VALUES(${org},${owner},'',${sql.json(emptyPersonal.descriptor)}),(${org},${other},'saved personal value',${sql.json(savedPersonal.descriptor)})`;
  await sql`INSERT INTO workflows(id,org_id,agent_id,name,visibility,owner_user_id,instruction,description,content_bundle,created_by,updated_by,attachments)
    VALUES(${workflow},${org},${privateAgent},'original','public',${other},${workflowInstruction},'original description',${sql.json(sourceBundle.descriptor)},${other},${other},${sql.json(attachment.descriptor)}),
      (${retainedWorkflow},${org},${privateAgent},'second','private',${owner},${workflowInstruction},NULL,${sql.json(secondBundle.descriptor)},${owner},${owner},'{"kind":"empty"}'::jsonb),
      (${publicWorkflow},${org},${publicAgent},'second','public',${other},${workflowInstruction},NULL,${sql.json(secondBundle.descriptor)},${other},${other},'{"kind":"empty"}'::jsonb)`;
  await sql`INSERT INTO projects(id,org_id,user_id,name) VALUES(${originalProject},${org},${owner},'Existing Project')`;
  await sql`INSERT INTO chat_threads(id,user_id,agent_id,project_id,title,framework,framework_session_id,framework_session_run_id)
    VALUES(${chat},${owner},${privateAgent},${originalProject},${canary},'codex','native-session',${nativeRun}),
      (${otherChat},${other},${privateAgent},NULL,'other retained chat',NULL,NULL,NULL),
      (${randomUUID()},${owner},${publicAgent},NULL,'separate same-name Agent',NULL,NULL,NULL),
      (${randomUUID()},'foreign',${foreignAgent},NULL,'foreign untouched',NULL,NULL,NULL)`;
  await sql`INSERT INTO workflow_automations(id,org_id,workflow_id,owner_user_id,kind,schedule_type,interval_seconds,enabled)
    VALUES(${badAutomation},${org},${workflow},${other},'schedule','loop',900,false),
      (${keptAutomation},${org},${retainedWorkflow},${owner},'schedule','loop',900,true),
      (${disabledAutomation},${org},${retainedWorkflow},${owner},'schedule','loop',1800,false)`;
  await sql`INSERT INTO workflow_user_automation_threads(id,org_id,user_id,workflow_id,chat_thread_id)
    VALUES(${binding},${org},${other},${workflow},${otherChat}),
      (${randomUUID()},${org},${owner},${retainedWorkflow},${chat})`;
  await sql`INSERT INTO workflow_schedule_skips(automation_id,scheduled_anchor_at,skipped_at)
    VALUES(${badAutomation},'2026-11-01 10:00:00.123456','2026-11-01 11:00:00.654321')`;
  await sql`INSERT INTO agent_runs(id,user_id,org_id,agent_id,chat_thread_id,status,prompt,trigger_source,autonomy_budget,workflow_automation_id,result)
    VALUES(${historicalRun},${other},${org},${privateAgent},${otherChat},'completed','retained historical prompt','automation',0,${badAutomation},'{"wide":9007199254740993}'::jsonb)`;
  await sql`INSERT INTO agent_runs(id,user_id,org_id,agent_id,chat_thread_id,status,prompt,trigger_source,autonomy_budget)
    VALUES(${nativeRun},${owner},${org},${privateAgent},${chat},'completed','native history','web',0)`;
  await sql`INSERT INTO chat_threads(id,user_id,agent_id,title)
    SELECT gen_random_uuid(),${owner},${privateAgent},'retained scale fixture' FROM generate_series(1,11065)`;
  const snapshotProjection = object({
    value: chatThreadSnapshotProjectionSchema,
  }).parse(
    (
      await sql`SELECT jsonb_build_object(
    'id',id,'agentId',agent_id,'projectId',project_id,'title',title,
    'sortAt',to_char(last_message_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pinnedAt',pinned_at,'pinOrder',pin_order,'archived',archived,'renamedAt',renamed_at,
    'selectedModel',selected_model,'modelSettings',model_settings
  ) AS value FROM chat_threads WHERE id=${chat}`
    )[0],
  ).value;
  async function replayPublishedMetadata() {
    const events = array(object({ value: chatThreadEventSchema })).parse(
      await sql`SELECT jsonb_build_object(
      'id',id,'seqId',seq_id,'kind',kind,'chatThreadId',chat_thread_id,'agentId',agent_id,
      'projectId',project_id,'title',title,'pinOrder',pin_order,
      'createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) || CASE WHEN reassigned_agent_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reassignedAgentId',reassigned_agent_id) END AS value
    FROM chat_thread_events WHERE chat_thread_id=${chat} ORDER BY seq_id`,
    );
    return replayChatThreadEvents(
      [snapshotProjection],
      events.map((row) => {
        return row.value;
      }),
    )[0];
  }
  const baseline = await dataState();
  const originalObjects = new Set(objects.keys());
  let sequence = 0;
  async function prepare() {
    const index = ++sequence;
    const inventory = join(directory, `${index}-inventory.json`),
      plan = join(directory, `${index}-plan.json`),
      destination = join(directory, `${index}-execution`);
    await invoke(
      [
        "inventory",
        "--org-id",
        org,
        "--target",
        "isolated-test-copy",
        "--output",
        inventory,
      ],
      true,
      preparationCli,
    );
    await invoke(
      ["plan", "--org-id", org, "--inventory", inventory, "--output", plan],
      true,
      preparationCli,
    );
    const planned = await readFile(plan);
    await invoke([
      "prepare",
      "--org-id",
      org,
      "--target",
      "isolated-test-copy",
      "--directory",
      destination,
      "--inventory",
      inventory,
      "--plan",
      plan,
      "--expect-plan-sha256",
      contentBundleDigest(planned),
    ]);
    const image = await readFile(join(destination, "execution.json"));
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(destination, "execution.json"))).mode & 0o777,
      0o600,
    );
    assert.ok(
      image.includes(canary),
      "private recovery image preserves complete source content",
    );
    assert.ok(
      image.includes("9007199254740993"),
      "wide numeric values remain exact PostgreSQL JSON text",
    );
    return { destination, hash: contentBundleDigest(image) };
  }
  const prepared = await prepare();
  assert.equal(puts, 0, "preparation never publishes objects");
  assert.deepEqual(await dataState(), baseline);
  const commandArgs = (command: string, selected = prepared) => {
    return [
      command,
      "--org-id",
      org,
      "--target",
      "isolated-test-copy",
      "--directory",
      selected.destination,
      "--expect-image-sha256",
      selected.hash,
    ];
  };
  const writeFlags = ["--rehearsal", "--writers-drained", "--migrate"];
  assert.match(
    (await invoke(commandArgs("verify"))).stdout,
    /"state":"before"/u,
  );
  assert.match(
    (await invoke(commandArgs("apply"), false)).stderr,
    /RehearsalWritersDrainedAndMigrateRequired/u,
  );
  const wrongHash = commandArgs("apply");
  wrongHash[wrongHash.length - 1] = "0".repeat(64);
  assert.match(
    (await invoke([...wrongHash, ...writeFlags], false)).stderr,
    /ExecutionImageHashMismatch/u,
  );
  assert.equal(puts, 0);
  await sql`INSERT INTO queued_chat_threads(chat_thread_id,org_id,queued_at) VALUES(${chat},${org},timezone('UTC',now()))`;
  assert.match(
    (await invoke([...commandArgs("apply"), ...writeFlags], false)).stderr,
    /DrainActiveAndQueuedWorkBeforeExecution/u,
  );
  assert.equal(puts, 0, "queued work blocks before any object publication");
  await sql`DELETE FROM queued_chat_threads WHERE chat_thread_id=${chat}`;

  const forged = object({
    tables: array(
      object({
        name: string(),
        rows: array(object({ after: string().nullable() }).passthrough()),
      }).passthrough(),
    ),
  })
    .passthrough()
    .parse(
      JSON.parse(
        await readFile(join(prepared.destination, "execution.json"), "utf8"),
      ),
    );
  const forgedPersonal = forged.tables
    .find((table) => {
      return table.name === "instructions";
    })
    ?.rows.find((row) => {
      return row.after?.includes(administrator);
    });
  assert.ok(forgedPersonal?.after);
  const forgedBody = object({ org_id: string() })
    .passthrough()
    .parse(JSON.parse(forgedPersonal.after));
  forgedBody.org_id = foreignOrg;
  forgedPersonal.after = JSON.stringify(forgedBody);
  const forgedDirectory = join(directory, "forged-image");
  await mkdir(forgedDirectory, { mode: 0o700 });
  const forgedBytes = JSON.stringify(forged) + "\n";
  await writeFile(join(forgedDirectory, "execution.json"), forgedBytes, {
    mode: 0o600,
  });
  const forgedArgs = [
    "apply",
    "--org-id",
    org,
    "--target",
    "isolated-test-copy",
    "--directory",
    forgedDirectory,
    "--expect-image-sha256",
    contentBundleDigest(Buffer.from(forgedBytes)),
    ...writeFlags,
  ];
  assert.match(
    (await invoke(forgedArgs, false)).stderr,
    /ExecutionImageDoesNotMatchApprovedActions/u,
  );
  assert.deepEqual(await dataState(), baseline);

  dropWriteResponse = true;
  await invoke([...commandArgs("apply"), ...writeFlags], false);
  assert.equal(
    dropWriteResponse,
    false,
    "the actual committed database response was dropped",
  );
  assert.match(
    (await invoke(commandArgs("verify"))).stdout,
    /"state":"after"/u,
  );
  const migrated = await dataState(),
    events = await eventsState(),
    published = puts;
  const replayed = await replayPublishedMetadata();
  assert.ok(replayed);
  assert.equal(replayed.agentId, target);
  assert.notEqual(replayed.projectId, originalProject);
  assert.equal(
    replayed.sortAt,
    snapshotProjection.sortAt,
    "migration identity events do not manufacture recent chat activity",
  );
  assert.equal(
    migrated.agents,
    baseline.agents,
    "source Agent records and their scope remain unchanged",
  );
  assert.equal(migrated.org_metadata, baseline.org_metadata);
  assert.equal(migrated.org_members_cache, baseline.org_members_cache);
  assert.match(
    (await invoke([...commandArgs("apply"), ...writeFlags])).stdout,
    /already-applied/u,
  );
  assert.deepEqual(await dataState(), migrated);
  assert.equal(
    await eventsState(),
    events,
    "resuming an uncertain commit emits no duplicate metadata events",
  );
  assert.equal(
    puts,
    published,
    "resume verifies existing hash objects without uploading again",
  );
  const moved = object({
    agent_id: string(),
    owner_user_id: string(),
    visibility: string(),
    name: string(),
  }).parse(
    (
      await sql`SELECT agent_id,owner_user_id,visibility,name FROM workflows WHERE id=${workflow}`
    )[0],
  );
  assert.equal(moved.agent_id, target);
  assert.equal(moved.owner_user_id, owner);
  assert.equal(moved.visibility, "private");
  assert.match(moved.name, /--wf-original$/u);
  const native = object({
    agent_id: string(),
    framework_session_id: string(),
    framework_session_run_id: string(),
  }).parse(
    (
      await sql`SELECT agent_id,framework_session_id,framework_session_run_id FROM chat_threads WHERE id=${chat}`
    )[0],
  );
  assert.equal(native.agent_id, target);
  assert.equal(native.framework_session_id, "native-session");
  assert.equal(native.framework_session_run_id, nativeRun);
  const personal = array(
    object({ user_id: string(), content: string() }),
  ).parse(
    await sql`SELECT user_id,content FROM instructions WHERE org_id=${org} ORDER BY user_id`,
  );
  assert.equal(
    personal.find((row) => {
      return row.user_id === owner;
    })?.content,
    "",
  );
  assert.equal(
    personal.find((row) => {
      return row.user_id === administrator;
    })?.content,
    defaultText,
  );
  assert.equal(
    personal.find((row) => {
      return row.user_id === other;
    })?.content,
    "saved personal value",
  );
  const publishedBundle = object({ content_bundle: contentBundleSchema }).parse(
    (await sql`SELECT content_bundle FROM workflows WHERE id=${workflow}`)[0],
  ).content_bundle;
  const archive = objects.get(contentBundleKey(publishedBundle.sha256));
  assert.ok(archive);
  const publishedFiles = readContentBundle(archive, publishedBundle);
  assert.deepEqual(
    publishedFiles.find((file) => {
      return file.path === "assets/bytes.bin";
    })?.content,
    Buffer.from([0, 255, 128]),
  );
  let scriptMode: number | undefined;
  const parser = new Parser({
    onReadEntry(entry) {
      if (entry.path === "scripts/run.sh") scriptMode = entry.mode;
      entry.resume();
    },
  });
  parser.end(gunzipSync(archive));
  assert.equal(
    scriptMode,
    0o755,
    "renaming preserves executable attachment modes",
  );
  assert.equal(
    (await sql`SELECT id FROM workflow_automations WHERE id=${badAutomation}`)
      .length,
    0,
  );
  assert.equal(
    (await sql`SELECT id FROM chat_threads WHERE id=${otherChat}`).length,
    1,
  );
  assert.equal(
    (
      await sql`SELECT id FROM workflow_automations WHERE id IN (${keptAutomation},${disabledAutomation})`
    ).length,
    2,
  );

  await sql`UPDATE workflows SET description='edited after migration' WHERE id=${workflow}`;
  const edited = await dataState();
  assert.match(
    (await invoke([...commandArgs("recover"), ...writeFlags], false)).stderr,
    /ExecutionStateDrift/u,
  );
  assert.deepEqual(
    await dataState(),
    edited,
    "recovery never overwrites a subsequent edit",
  );
  await sql`UPDATE workflows SET description='original description' WHERE id=${workflow}`;
  assert.match(
    (await invoke([...commandArgs("recover"), ...writeFlags])).stdout,
    /"status":"recovered"/u,
  );
  assert.deepEqual(
    await dataState(),
    baseline,
    "recovery restores parents, cascaded rows, Run references and prior Project membership exactly",
  );
  const restoredProjection = await replayPublishedMetadata();
  assert.ok(restoredProjection);
  assert.equal(restoredProjection.agentId, privateAgent);
  assert.equal(restoredProjection.projectId, originalProject);
  assert.equal(restoredProjection.sortAt, snapshotProjection.sortAt);
  const recoveredEvents = await eventsState();
  assert.match(
    (await invoke([...commandArgs("recover"), ...writeFlags])).stdout,
    /already-recovered/u,
  );
  assert.equal(await eventsState(), recoveredEvents);
  assert.ok(
    objects.size > originalObjects.size,
    "recovery retains shared immutable hash objects",
  );
  assert.match(
    (await invoke([...commandArgs("apply"), ...writeFlags], false)).stderr,
    /ExecutionSourceRevisionDrift/u,
  );

  const fresh = await prepare();
  const preparedFiles = (
    await readdir(join(fresh.destination, "bundles"))
  ).filter((file) => {
    return !originalObjects.has(
      contentBundleKey(file.replace(/\.tar\.gz$/u, "")),
    );
  });
  assert.ok(preparedFiles[0]);
  objects.delete(contentBundleKey(preparedFiles[0].replace(/\.tar\.gz$/u, "")));
  let uploadReached!: () => void, releaseUpload!: () => void;
  const reached = new Promise<void>((resolve) => {
    uploadReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  blockUpload = { reached: uploadReached, released };
  releasePendingUpload = releaseUpload;
  const applying = invoke(
    [...commandArgs("apply", fresh), ...writeFlags],
    false,
  );
  pendingApply = applying;
  await Promise.race([
    reached,
    applying.then(() => {
      throw new Error("Apply completed before the held object-store request");
    }),
  ]);
  const concurrentBundle = await prepareContentBundle([
    {
      path: "instructions.md",
      content: Buffer.from("concurrent personal save"),
    },
  ]);
  objects.set(
    contentBundleKey(concurrentBundle.descriptor.sha256),
    concurrentBundle.archive,
  );
  await sql`INSERT INTO instructions(org_id,user_id,content,bundle) VALUES(${org},${administrator},'concurrent personal save',${sql.json(concurrentBundle.descriptor)})`;
  const concurrentlySaved = await dataState(),
    beforeEvents = await eventsState();
  releaseUpload();
  await applying;
  assert.deepEqual(
    await dataState(),
    concurrentlySaved,
    "a concurrent first save aborts the entire database publication",
  );
  assert.equal(
    await eventsState(),
    beforeEvents,
    "a rejected publication emits no metadata events",
  );
  assert.equal(serverErrors.length, 0);
  console.log(
    "Single Agent execution: private preparation, exact content, scoped atomic apply, uncertain-commit resume, full FK recovery, drift rejection and concurrent personal saves passed",
  );
} finally {
  releasePendingUpload?.();
  if (pendingApply) await Promise.allSettled([pendingApply]);
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise<void>((resolve) => {
      return store.close(() => {
        return resolve();
      });
    }),
    new Promise<void>((resolve) => {
      return proxy.close(() => {
        return resolve();
      });
    }),
  ]);
  await sql.end();
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
  } finally {
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
