import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  randomBytes,
  randomUUID,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  readdir,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { c, Parser } from "tar";
import { boolean, object, string } from "zod";
import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";
import {
  contentBundleDigest,
  contentBundleKey,
} from "@okouai/core/content-bundle";
import { readTemplateGuidanceBundle } from "@okouai/core/template-guidance-bundle";
import { planSchema, type Source, type PlannedRow } from "./plan";

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error("Disposable DATABASE_URL required");
const address = new URL(connection);
if (
  (!["127.0.0.1", "localhost"].includes(address.hostname) &&
    !(
      address.hostname === "postgres" &&
      address.pathname === "/migration_test_existing"
    )) ||
  address.searchParams.has("host") ||
  address.searchParams.has("port")
)
  throw new Error(
    "Disposable local or migration-consistency database required",
  );
const db = new Client({ connectionString: connection });
const directory = await mkdtemp(join(tmpdir(), "template-backfill-test-"));
const objects = new Map<string, Buffer>();
const ids: { table: string; id: string }[] = [];
let puts = 0;
let losePutResponse = false;
let onPut: (() => Promise<void>) | undefined;
async function handle(request: IncomingMessage, response: ServerResponse) {
  const key = decodeURIComponent(
    new URL(request.url ?? "/", "http://fixture.test").pathname,
  ).replace(/^\/test\//u, "");
  if (request.method === "GET") {
    const bytes = objects.get(key);
    if (!bytes) {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    response.writeHead(200, { "content-length": bytes.length });
    response.end(bytes);
    return;
  }
  if (request.method === "PUT") {
    if (request.headers["if-none-match"] !== "*") {
      response.writeHead(400);
      response.end();
      return;
    }
    if (objects.has(key)) {
      response.writeHead(412);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
    puts++;
    const action = onPut;
    onPut = undefined;
    await action?.();
    if (losePutResponse) {
      losePutResponse = false;
      response.destroy();
      return;
    }
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
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw new Error("Missing peer address");
  const endpoint = `http://127.0.0.1:${bound.port}`;
  const credential = join(directory, "database-url");
  await writeFile(credential, connection, { mode: 0o600 });
  const environment = {
    PATH: process.env.PATH,
    NODE_OPTIONS: "--max-old-space-size=1536",
    DATABASE_URL_FILE: credential,
    R2_ENDPOINT: endpoint,
    R2_USER_STORAGES_BUCKET_NAME: "test",
    R2_ACCESS_KEY_ID: "fixture",
    R2_SECRET_ACCESS_KEY: "fixture",
  };
  let sequence = 0;
  async function invoke(
    args: string[],
    fail = false,
    overrides: NodeJS.ProcessEnv = {},
  ) {
    const output = join(directory, `${++sequence}-output`);
    const call = promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/migrations/029-template-guidance-bundles/backfill.ts",
        ...args,
        "--output",
        output,
      ],
      { env: { ...environment, ...overrides } },
    );
    if (fail) await assert.rejects(call);
    else await call;
    return output;
  }
  async function fixture(ownerKind: Source["ownerKind"], large = false) {
    const templateId = randomUUID(),
      storageId = randomUUID(),
      orgId = `fixture-${randomUUID()}`;
    const table =
      ownerKind === "user-template"
        ? "user_templates"
        : "presentation_templates";
    ids.push({ table, id: templateId });
    if (ownerKind === "user-template") {
      await db.query(
        "INSERT INTO user_templates (id,org_id,owner_user_id,title,source_storage_key,source_filename,manifest,created_by,updated_by) VALUES ($1,$2,'fixture','private title','owned/source.pdf','source.pdf',$3,'fixture','fixture')",
        [templateId, orgId, { kind: "document", pageCount: 1, coverKey: null }],
      );
    } else {
      await db.query(
        "INSERT INTO presentation_templates (id,org_id,owner_user_id,title,source_storage_key,source_filename,page_keys,created_by,updated_by) VALUES ($1,$2,'fixture','private title','owned/source.pdf','source.pdf',ARRAY['owned/page.png'],'fixture','fixture')",
        [templateId, orgId],
      );
    }
    const owner = (
      await db.query(
        `SELECT to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM ${table} WHERE id=$1`,
        [templateId],
      )
    ).rows[0];
    const files: { path: string; content: Buffer }[] = [
      {
        path: "SKILL.md",
        content: Buffer.from(`\uFEFF fixture ${templateId}\r\n  `),
      },
      { path: "design-system.md", content: Buffer.from(" private design\n") },
      { path: "assets/raw.bin", content: Buffer.from([0, 255, 128, 1]) },
    ];
    if (large)
      files.push(
        { path: "assets/one.bin", content: randomBytes(17 * 1024 * 1024) },
        { path: "assets/two.bin", content: randomBytes(17 * 1024 * 1024) },
      );
    const root = join(directory, templateId);
    await mkdir(root);
    for (const file of files) {
      await mkdir(join(root, file.path, ".."), { recursive: true });
      await writeFile(join(root, file.path), file.content, { mode: 0o644 });
    }
    const archivePath = join(directory, `${templateId}.tar.gz`);
    await c({ cwd: root, file: archivePath, gzip: true, portable: true }, [
      ".",
    ]);
    const archive = await readFile(archivePath);
    const entries = files.map((f) => {
      return {
        path: f.path,
        hash: contentBundleDigest(f.content),
        size: f.content.length,
      };
    });
    const versionId = computeContentHashFromHashes(storageId, entries),
      s3Key = `${orgId}/${storageId}/${versionId}`;
    const totalBytes = files.reduce((n, f) => {
      return n + f.content.length;
    }, 0);
    objects.set(`${s3Key}/archive.tar.gz`, archive);
    objects.set(
      `${s3Key}/manifest.json`,
      Buffer.from(
        JSON.stringify({
          version: versionId,
          createdAt: new Date().toISOString(),
          totalSize: totalBytes,
          fileCount: files.length,
          files: entries,
        }),
      ),
    );
    const source: Source = {
      ownerKind,
      templateId,
      orgId,
      ownerUserId: "fixture",
      ownerUpdatedAt: owner.at,
      package: {
        storageId,
        versionId,
        s3Key,
        archiveBytes: archive.length,
        totalBytes,
        fileCount: files.length,
      },
    };
    return { source, files, table };
  }
  async function plan(sources: Source[]) {
    const input = join(directory, `${++sequence}-inventory.json`);
    await writeFile(
      input,
      JSON.stringify({
        format: "template-guidance-sources-v1",
        capturedAt: new Date().toISOString(),
        scope: {
          database: `${address.hostname}:${address.port || "5432"}${address.pathname}`,
          bucket: "test",
          endpoint,
        },
        rows: sources,
      }),
    );
    const path = await invoke(["--inventory", input]);
    const parsed = planSchema.parse(JSON.parse(await readFile(path, "utf8")));
    assert.equal(parsed.complete, true);
    const first = parsed.rows[0];
    assert.ok(first);
    return { path, parsed, first, inventory: input };
  }
  async function apply(
    path: string,
    fail = false,
    overrides: NodeJS.ProcessEnv = {},
  ) {
    return invoke(
      [
        "--migrate",
        "--writers-drained",
        "--plan-file",
        path,
        "--expect-plan-sha256",
        contentBundleDigest(await readFile(path)),
      ],
      fail,
      overrides,
    );
  }
  async function owner(row: PlannedRow) {
    const table =
      row.source.ownerKind === "user-template"
        ? "user_templates"
        : "presentation_templates";
    return (
      await db.query(
        `SELECT guidance_bundle, title, source_storage_key, source_filename, updated_at::text, xmin::text AS revision FROM ${table} WHERE id=$1`,
        [row.source.templateId],
      )
    ).rows[0];
  }

  const user = await fixture("user-template", true),
    presentation = await fixture("presentation-template");
  assert.ok(user.source.package.archiveBytes > 32 * 1024 * 1024);
  const first = await plan([user.source, presentation.source]);
  assert.equal(puts, 0);
  const original = await Promise.all(first.parsed.rows.map(owner));
  assert.ok(
    original.every((r) => {
      return r.guidance_bundle === null;
    }),
  );
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const recipient = join(directory, "recipient.pem"),
    capture = join(directory, "capture");
  await writeFile(recipient, publicKey.export({ type: "spki", format: "pem" }));
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/migrations/029-template-guidance-bundles/capture.ts",
      "--inventory",
      first.inventory,
      "--public-key",
      recipient,
      "--output",
      capture,
    ],
    {
      env: {
        PATH: environment.PATH,
        NODE_OPTIONS: environment.NODE_OPTIONS,
        R2_ENDPOINT: endpoint,
        R2_USER_STORAGES_BUCKET_NAME: "test",
        R2_ACCESS_KEY_ID: "fixture",
        R2_SECRET_ACCESS_KEY: "fixture",
      },
    },
  );
  assert.deepEqual((await readdir(capture)).sort(), [
    "envelope.json",
    "payload.enc",
    "report.json",
  ]);
  assert.equal(
    object({ complete: boolean() }).parse(
      JSON.parse(await readFile(join(capture, "report.json"), "utf8")),
    ).complete,
    true,
  );
  const envelope = object({
    wrappedKey: string(),
    iv: string(),
    tag: string(),
  }).parse(JSON.parse(await readFile(join(capture, "envelope.json"), "utf8")));
  const key = privateDecrypt(
    { key: privateKey, oaepHash: "sha256" },
    Buffer.from(envelope.wrappedKey, "base64"),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(await readFile(join(capture, "payload.enc"))),
    decipher.final(),
  ]);
  key.fill(0);
  const restored = new Map<string, Buffer>();
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        restored.set(entry.path, Buffer.concat(chunks));
      });
    },
  });
  parser.end(plaintext);
  for (const source of [user.source, presentation.source]) {
    for (const name of ["archive.tar.gz", "manifest.json"]) {
      assert.deepEqual(
        restored.get(`${source.ownerKind}/${source.templateId}/${name}`),
        objects.get(`${source.package.s3Key}/${name}`),
      );
    }
  }
  assert.equal(puts, 0, "capture only reads objects");
  assert.deepEqual(await Promise.all(first.parsed.rows.map(owner)), original);
  losePutResponse = true;
  const receipt = await apply(first.path);
  assert.equal(
    JSON.parse((await readFile(receipt, "utf8")).trim().split("\n").at(-1)!)
      .complete,
    true,
  );
  for (const [index, row] of first.parsed.rows.entries()) {
    const current = await owner(row);
    assert.deepEqual(current.guidance_bundle, row.bundle);
    assert.deepEqual(
      { ...current, revision: null, guidance_bundle: null },
      { ...original[index], revision: null },
    );
    const actual = readTemplateGuidanceBundle(
      objects.get(contentBundleKey(row.bundle.sha256))!,
      row.bundle,
    );
    const expected = index === 0 ? user.files : presentation.files;
    assert.deepEqual(
      actual.map((f) => {
        return {
          path: f.path,
          hash: contentBundleDigest(f.content),
        };
      }),
      [...expected]
        .sort((a, b) => {
          return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
        })
        .map((f) => {
          return { path: f.path, hash: contentBundleDigest(f.content) };
        }),
    );
  }
  const published = await Promise.all(first.parsed.rows.map(owner));
  const count = puts;
  await apply(first.path);
  assert.equal(puts, count);
  assert.deepEqual(await Promise.all(first.parsed.rows.map(owner)), published);

  const edited = await fixture("user-template");
  const editPlan = await plan([edited.source]);
  await db.query(
    "UPDATE user_templates SET title='new title', updated_at=now() WHERE id=$1",
    [edited.source.templateId],
  );
  await apply(editPlan.path, true);
  assert.equal((await owner(editPlan.first)).title, "new title");
  assert.equal((await owner(editPlan.first)).guidance_bundle, null);

  const raced = await fixture("user-template");
  const racePlan = await plan([raced.source]);
  onPut = async () => {
    await db.query(
      "UPDATE user_templates SET title='concurrent title' WHERE id=$1",
      [raced.source.templateId],
    );
  };
  await apply(racePlan.path, true);
  assert.equal((await owner(racePlan.first)).title, "concurrent title");
  assert.equal((await owner(racePlan.first)).guidance_bundle, null);

  const replaced = await fixture("user-template");
  const replacePlan = await plan([replaced.source]);
  const foreign = first.first.bundle;
  await db.query("UPDATE user_templates SET guidance_bundle=$2 WHERE id=$1", [
    replaced.source.templateId,
    foreign,
  ]);
  await apply(replacePlan.path, true);
  assert.deepEqual((await owner(replacePlan.first)).guidance_bundle, foreign);

  const deleted = await fixture("presentation-template");
  const deletePlan = await plan([deleted.source]);
  onPut = async () => {
    await db.query("DELETE FROM presentation_templates WHERE id=$1", [
      deleted.source.templateId,
    ]);
  };
  await apply(deletePlan.path, true);
  assert.equal(await owner(deletePlan.first), undefined);

  const changed = await fixture("user-template");
  const changedPlan = await plan([changed.source]);
  const changedKey = `${changed.source.package.s3Key}/archive.tar.gz`;
  const archive = Buffer.from(objects.get(changedKey)!);
  archive.writeUInt8(archive.readUInt8(4) ^ 1, 4);
  objects.set(changedKey, archive);
  await apply(changedPlan.path, true);
  assert.equal((await owner(changedPlan.first)).guidance_bundle, null);

  const conflict = await fixture("user-template");
  const conflictPlan = await plan([conflict.source]);
  const target = contentBundleKey(conflictPlan.first.bundle.sha256);
  const poison = Buffer.from("conflicting bytes");
  objects.set(target, poison);
  await apply(conflictPlan.path, true);
  assert.deepEqual(objects.get(target), poison);
  assert.equal((await owner(conflictPlan.first)).guidance_bundle, null);
  await apply(conflictPlan.path, true, {
    R2_USER_STORAGES_BUCKET_NAME: "foreign",
  });
  await invoke(
    [
      "--migrate",
      "--writers-drained",
      "--plan-file",
      conflictPlan.path,
      "--expect-plan-sha256",
      "0".repeat(64),
    ],
    true,
  );
  console.log(
    "PASS: both owner kinds, >32 MiB archive, exact binary/text bytes, lost PUT recovery, idempotency, edited/replaced/deleted owners, CAS upload races, frozen source changes, immutable conflicts and reviewed scope/hash.",
  );
} finally {
  try {
    for (const id of ids)
      await db.query(`DELETE FROM ${id.table} WHERE id=$1`, [id.id]);
  } finally {
    await db.end();
    await new Promise<void>((resolve) => {
      server.close(() => {
        return resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
}
