import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { create } from "tar";
import { array, object, string } from "zod";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import {
  computeContentHashFromHashes,
  hashFileContent,
} from "@okouai/api-contracts/contracts/storage-content-hash";
import {
  prepareContentBundle,
  contentBundleKey,
  contentBundleDigest,
  readContentBundle,
} from "@okouai/core/content-bundle";
import { officialWorkflowExecutionFiles } from "@okouai/core/official-workflow-artifact";

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error("Disposable DATABASE_URL required");
const address = new URL(connection);
if (
  !["127.0.0.1", "localhost"].includes(address.hostname) &&
  !(
    address.hostname === "postgres" &&
    address.pathname === "/migration_test_existing"
  )
)
  throw new Error("Disposable database required");
if (address.searchParams.has("host") || address.searchParams.has("port"))
  throw new Error("Canonical database address required");
const db = new Client({ connectionString: connection });
const directory = await mkdtemp(join(tmpdir(), "official-bundle-operator-"));
const objects = new Map<string, Buffer>();
let failUpload = false;
let puts = 0;
const name = `000-official-${randomUUID().slice(0, 8)}`;
const childName = `${name}-child`;
const storageId = randomUUID();
const revision = "a".repeat(64);
const storageName = `official-workflow@${name}`;
const definition = {
  schemaVersion: 3,
  name,
  revision,
  workflow: {
    displayName: "Official report",
    description: "Prepare the report",
    instruction: "# Report\n\nSummarize changes.\n",
    files: [
      { path: "references/你好.txt", content: "Preserve these exact bytes.\n" },
    ],
  },
  blueprints: [],
};
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isJsonObject(value))
    return `{${Object.entries(value)
      .sort(([a], [b]) => {
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .map(([key, item]) => {
        return `${JSON.stringify(key)}:${canonical(item)}`;
      })
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unsupported fixture value");
  return encoded;
}
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
    puts++;
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
const exec = promisify(execFile);
const receiptSchema = object({
  rows: array(object({ id: string(), bundle: contentBundleSchema })),
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
  const files = [
    ...officialWorkflowExecutionFiles(definition),
    {
      path: ".vm0/official-workflow-definition.json",
      content: `${canonical(definition)}\n`,
    },
  ];
  const version = computeContentHashFromHashes(
    storageId,
    files.map((file) => {
      return {
        path: file.path,
        hash: hashFileContent(Buffer.from(file.content)),
        size: Buffer.byteLength(file.content),
      };
    }),
  );
  const s3Key = `__system__/${storageId}/${version}`;
  for (const file of files) {
    const target = join(directory, "source", file.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.content);
  }
  const archivePath = join(directory, "source.tar.gz");
  await create(
    {
      file: archivePath,
      cwd: join(directory, "source"),
      gzip: true,
      portable: true,
      mtime: new Date(0),
    },
    files.map((file) => {
      return file.path;
    }),
  );
  const archive = await readFile(archivePath);
  objects.set(`${s3Key}/archive.tar.gz`, archive);
  await db.query(
    `INSERT INTO storages (id,user_id,org_id,name,s3_prefix) VALUES ($1,'__org__','__system__',$2,$3)`,
    [storageId, storageName, `__system__/${storageId}`],
  );
  await db.query(
    `INSERT INTO storage_versions (id,storage_id,s3_key,size,archive_size,file_count,created_by) VALUES ($1,$2,$3,$4,$5,$6,'user')`,
    [
      version,
      storageId,
      s3Key,
      files.reduce((sum, file) => {
        return sum + Buffer.byteLength(file.content);
      }, 0),
      archive.length,
      files.length,
    ],
  );
  await db.query(
    `INSERT INTO official_workflow_definition_revisions (definition_name,revision,payload,storage_name,storage_id,storage_version) VALUES ($1,$2,$3,$4,$5,$6)`,
    [name, revision, definition, storageName, storageId, version],
  );
  const childDefinition = {
    ...definition,
    name: childName,
    revision: "b".repeat(64),
  };
  const child = await prepareContentBundle(
    officialWorkflowExecutionFiles(childDefinition).map((file) => {
      return { path: file.path, content: Buffer.from(file.content, "utf8") };
    }),
  );
  objects.set(contentBundleKey(child.descriptor.sha256), child.archive);
  await db.query(
    `INSERT INTO official_workflow_definition_revisions (definition_name,revision,payload,content_bundle) VALUES ($1,$2,$3,$4)`,
    [childName, childDefinition.revision, childDefinition, child.descriptor],
  );
  const run = (args: string[]) => {
    return exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/migrations/028-official-workflow-bundles/backfill.ts",
        "--limit",
        "1",
        ...args,
      ],
      { env: environment, maxBuffer: 1024 * 1024 },
    );
  };
  const plan = join(directory, "plan.json");
  await run(["--output", plan]);
  const bytes = await readFile(plan);
  const reviewed = receiptSchema.parse(JSON.parse(bytes.toString()));
  const first = reviewed.rows[0];
  assert.equal(first?.id, `${name}/${revision}`);
  assert.ok(first);
  const nextPage = join(directory, "after-root.json");
  await run(["--after", first.id, "--output", nextPage]);
  const next = receiptSchema.parse(
    JSON.parse((await readFile(nextPage)).toString()),
  );
  assert.equal(
    next.rows[0]?.id,
    `${childName}/${childDefinition.revision}`,
    "primary-key pagination must retain names with the preceding name as a prefix",
  );
  assert.equal(puts, 0);
  assert.equal(
    (
      await db.query(
        `SELECT content_bundle FROM official_workflow_definition_revisions WHERE definition_name=$1`,
        [name],
      )
    ).rows[0].content_bundle,
    null,
  );
  const applyArgs = [
    "--migrate",
    "--writers-drained",
    "--plan-file",
    plan,
    "--expect-plan-sha256",
    contentBundleDigest(bytes),
  ];
  failUpload = true;
  await assert.rejects(
    run([...applyArgs, "--output", join(directory, "failed.json")]),
  );
  assert.equal(
    (
      await db.query(
        `SELECT content_bundle FROM official_workflow_definition_revisions WHERE definition_name=$1`,
        [name],
      )
    ).rows[0].content_bundle,
    null,
  );
  failUpload = false;
  await run([...applyArgs, "--output", join(directory, "applied.json")]);
  const published = (
    await db.query(
      `SELECT content_bundle FROM official_workflow_definition_revisions WHERE definition_name=$1`,
      [name],
    )
  ).rows[0].content_bundle;
  assert.deepEqual(published, first.bundle);
  const bundleBytes = objects.get(contentBundleKey(first.bundle.sha256));
  assert.ok(bundleBytes);
  const installed = readContentBundle(bundleBytes, first.bundle);
  assert.equal(installed.length, 2);
  assert.ok(
    !installed.some((file) => {
      return file.path === ".vm0/official-workflow-definition.json";
    }),
  );
  assert.equal(
    installed
      .find((file) => {
        return file.path === "references/你好.txt";
      })
      ?.content.toString(),
    definition.workflow.files[0]?.content,
  );
  assert.equal(puts, 1);
  await run([...applyArgs, "--output", join(directory, "verified.json")]);
  assert.equal(
    puts,
    1,
    "already published references are verified without another PUT",
  );
  await assert.rejects(
    run([
      "--migrate",
      "--writers-drained",
      "--plan-file",
      plan,
      "--expect-plan-sha256",
      "0".repeat(64),
      "--output",
      join(directory, "bad-plan.json"),
    ]),
  );
  objects.set(`${s3Key}/archive.tar.gz`, Buffer.from("corrupt"));
  await assert.rejects(
    run(["--output", join(directory, "corrupt-source.json")]),
  );
  console.log(
    "Official operator: dry-run, reviewed apply, exact legacy files, upload failure, recovery, idempotence, prefix-name pagination and corrupt-source rejection passed",
  );
} finally {
  try {
    await db.query(
      `DELETE FROM official_workflow_definition_revisions WHERE definition_name = ANY($1::text[])`,
      [[name, childName]],
    );
    await db.query(`DELETE FROM storage_versions WHERE storage_id=$1`, [
      storageId,
    ]);
    await db.query(`DELETE FROM storages WHERE id=$1`, [storageId]);
  } finally {
    await db.end();
    await new Promise<void>((resolve, reject) => {
      return server.close((error) => {
        return error ? reject(error) : resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
}
