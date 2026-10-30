import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { array, object, string } from "zod";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import {
  contentBundleKey,
  contentBundleDigest,
  readContentBundle,
} from "@okouai/core/content-bundle";
import { prepareWorkflowAttachmentBundle } from "@okouai/core/workflow-attachment-bundle";

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error("Disposable DATABASE_URL required");
const address = new URL(connection);
const local = ["127.0.0.1", "localhost"].includes(address.hostname);
const ownedCiDatabase =
  address.hostname === "postgres" &&
  address.pathname === "/migration_test_existing";
if (
  (!local && !ownedCiDatabase) ||
  address.searchParams.has("host") ||
  address.searchParams.has("port")
)
  throw new Error(
    "Disposable local or migration-consistency database required",
  );
const db = new Client({ connectionString: connection });
const directory = await mkdtemp(
  join(tmpdir(), "content-bundle-backfill-test-"),
);
const objects = new Map<string, Buffer>();
// Sort before the migration-consistency seed so a bounded page contains only this fixture.
const agent = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`,
  workflow = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`,
  org = `bundle-test-${randomUUID()}`;
let failUpload = false;
async function handle(request: IncomingMessage, response: ServerResponse) {
  const key = decodeURIComponent(
    new URL(request.url ?? "/", "http://fixture.test").pathname,
  ).replace(/^\/test\//u, "");
  if (request.method === "GET") {
    const body = objects.get(key);
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-length": body.length });
    response.end(body);
    return;
  }
  if (request.method === "PUT") {
    if (failUpload) {
      response.writeHead(500);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
    response.writeHead(200, { ETag: '"fixture"' });
    response.end();
    return;
  }
  response.writeHead(405);
  response.end();
}
const server = createServer((request, response) => {
  handle(request, response).catch(() => {
    response.writeHead(500);
    response.end();
  });
});
await db.connect();
try {
  await new Promise<void>((resolve) => {
    return server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === "string")
    throw new Error("Missing fixture endpoint");
  const credentials = join(directory, "database-url");
  await writeFile(credentials, connection, { mode: 0o600 });
  const environment = {
    ...process.env,
    DATABASE_URL_FILE: credentials,
    R2_ENDPOINT: `http://127.0.0.1:${endpoint.port}`,
    R2_ACCESS_KEY_ID: "fixture",
    R2_SECRET_ACCESS_KEY: "fixture",
    R2_USER_STORAGES_BUCKET_NAME: "test",
  };
  let sequence = 0;
  async function invoke(
    kind: "agent" | "workflow",
    plan?: string,
    failure = false,
    overrides: NodeJS.ProcessEnv = {},
    outputOverride?: string,
  ) {
    const output = outputOverride ?? join(directory, `${++sequence}.json`);
    const args = [
      "--import",
      "tsx",
      "scripts/migrations/027-content-bundles/backfill.ts",
      "--kind",
      kind,
      "--limit",
      "1",
      "--output",
      output,
    ];
    if (plan)
      args.push(
        "--migrate",
        "--writers-drained",
        "--plan-file",
        plan,
        "--expect-plan-sha256",
        contentBundleDigest(await readFile(plan)),
      );
    if (failure) {
      await assert.rejects(
        promisify(execFile)(process.execPath, args, {
          env: { ...environment, ...overrides },
        }),
      );
    } else {
      await promisify(execFile)(process.execPath, args, {
        env: { ...environment, ...overrides },
      });
    }
    return output;
  }
  await db.query(
    "INSERT INTO agents (id,org_id,owner,name,instructions) VALUES ($1::uuid,$2,'fixture',$1::text,$3)",
    [agent, org, "\uFEFF raw\r\n正文  "],
  );
  const attachment = await prepareWorkflowAttachmentBundle(org, workflow, [
    { path: "references/raw.bin", content: Buffer.from([0, 255, 128]) },
  ]);
  assert.equal(attachment.descriptor.kind, "bundle");
  if (attachment.descriptor.kind !== "bundle" || !attachment.archive)
    throw new Error("Missing fixture archive");
  objects.set(attachment.descriptor.objectKey, attachment.archive);
  await db.query(
    "INSERT INTO workflows (id,org_id,agent_id,name,owner_user_id,instruction,created_by,updated_by,attachments) VALUES ($1,$2,$3,'fixture-workflow','fixture',' workflow body ','fixture','fixture',$4)",
    [workflow, org, agent, JSON.stringify(attachment.descriptor)],
  );
  const plan = await invoke("agent");
  assert.equal(objects.size, 1, "dry-run performs no R2 publication");
  const before = await db.query(
    "SELECT instructions_bundle FROM agents WHERE id=$1",
    [agent],
  );
  assert.equal(
    before.rows[0].instructions_bundle,
    null,
    "dry-run leaves source reference unchanged",
  );
  await invoke("agent", plan, true, {}, plan);
  assert.equal(
    objects.size,
    1,
    "an existing output receipt rejects before R2 publication",
  );
  await invoke("agent", plan, true, {
    R2_USER_STORAGES_BUCKET_NAME: "foreign",
  });
  await invoke("agent", plan);
  const published = object({
    instructions_bundle: contentBundleSchema,
    instructions: string(),
  }).parse(
    (
      await db.query(
        "SELECT instructions_bundle,instructions FROM agents WHERE id=$1",
        [agent],
      )
    ).rows[0],
  );
  const body = objects.get(
    contentBundleKey(published.instructions_bundle.sha256),
  );
  assert.ok(body);
  const files = readContentBundle(body, published.instructions_bundle);
  assert.equal(files[0]?.content.toString(), published.instructions);
  const workflowPlan = await invoke("workflow");
  await invoke("workflow", workflowPlan);
  const descriptor = contentBundleSchema.parse(
    (
      await db.query("SELECT content_bundle FROM workflows WHERE id=$1", [
        workflow,
      ])
    ).rows[0].content_bundle,
  );
  const archive = objects.get(contentBundleKey(descriptor.sha256));
  assert.ok(archive);
  const contents = readContentBundle(archive, descriptor);
  assert.deepEqual(
    contents.find((file) => {
      return file.path === "references/raw.bin";
    })?.content,
    Buffer.from([0, 255, 128]),
  );
  assert.match(
    contents
      .find((file) => {
        return file.path === "SKILL.md";
      })
      ?.content.toString() ?? "",
    /workflow body/u,
  );
  const stale = await invoke("agent");
  await db.query(
    "UPDATE agents SET instructions='concurrent accepted edit' WHERE id=$1",
    [agent],
  );
  const staleReceipt = await invoke("agent", stale);
  const afterStale = await db.query(
    "SELECT instructions,instructions_bundle FROM agents WHERE id=$1",
    [agent],
  );
  assert.equal(afterStale.rows[0].instructions, "concurrent accepted edit");
  assert.deepEqual(
    afterStale.rows[0].instructions_bundle,
    published.instructions_bundle,
  );
  const receipt = object({ rows: array(object({ id: string() })) }).parse(
    JSON.parse(await readFile(staleReceipt, "utf8")),
  );
  assert.ok(
    receipt.rows.every((row) => {
      return row.id !== agent;
    }),
  );
  const retryPlan = await invoke("agent");
  failUpload = true;
  await invoke("agent", retryPlan, true);
  failUpload = false;
  assert.deepEqual(
    (
      await db.query("SELECT instructions_bundle FROM agents WHERE id=$1", [
        agent,
      ])
    ).rows[0].instructions_bundle,
    published.instructions_bundle,
  );
  await invoke("agent", retryPlan);
  const reconciled = contentBundleSchema.parse(
    (
      await db.query("SELECT instructions_bundle FROM agents WHERE id=$1", [
        agent,
      ])
    ).rows[0].instructions_bundle,
  );
  assert.notEqual(reconciled.sha256, published.instructions_bundle.sha256);
  const reconciledArchive = objects.get(contentBundleKey(reconciled.sha256));
  assert.ok(reconciledArchive);
  assert.equal(
    readContentBundle(reconciledArchive, reconciled)[0]?.content.toString(),
    "concurrent accepted edit",
  );
  console.log(
    "Content bundle backfill: dry-run, scope binding, exact bytes, stale-source exclusion, upload failure and retry passed",
  );
} finally {
  await db.query("DELETE FROM workflows WHERE id=$1", [workflow]);
  await db.query("DELETE FROM agents WHERE id=$1", [agent]);
  await db.end();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    return server.close((error) => {
      return error ? reject(error) : resolve();
    });
  });
  await rm(directory, { recursive: true, force: true });
}
