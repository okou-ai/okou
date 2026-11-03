import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { listPrivateRegistryResourceArchives } from "@okouai/core/private-registry-resource-archives";

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
) {
  throw new Error(
    "Disposable local or migration-consistency database required",
  );
}

const db = new Client({ connectionString: connection });
const root = await mkdtemp(join(tmpdir(), "registry-inventory-test-"));
const storageId = randomUUID();
const orgId = `registry-inventory-${randomUUID()}`;
const prefix = `registry-inventory-test/${storageId}`;
const versionId = createHash("sha256").update(storageId).digest("hex");
const nextVersionId = createHash("sha256").update(orgId).digest("hex");
let moveHead = false;
let body: Buffer = Buffer.alloc(0);

async function respond(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET") {
    response.writeHead(405);
    response.end();
    return;
  }
  const key = decodeURIComponent(
    new URL(request.url ?? "/", "http://fixture.test").pathname,
  );
  if (!key.startsWith(`/test/${prefix}/`) || !key.endsWith("/archive.tar.gz")) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (moveHead) {
    moveHead = false;
    await db.query("UPDATE storages SET head_version_id = $1 WHERE id = $2", [
      nextVersionId,
      storageId,
    ]);
  }
  response.writeHead(200, { "content-length": body.length });
  response.end(body);
}

const server = createServer((request, response) => {
  respond(request, response).catch(() => {
    response.writeHead(500);
    response.end();
  });
});

await db.connect();
let resourceId: string | undefined;
try {
  const candidates = listPrivateRegistryResourceArchives().filter((binding) => {
    return binding.latest;
  });
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM storage_versions WHERE id = ANY($1::text[])",
    [
      candidates.map((candidate) => {
        return candidate.versionId;
      }),
    ],
  );
  const used = new Set(
    existing.rows.map((row) => {
      return row.id;
    }),
  );
  const binding = candidates.find((candidate) => {
    return !used.has(candidate.versionId);
  });
  if (!binding) throw new Error("No unused fixture anchor");
  resourceId = binding.id;
  await mkdir(join(root, binding.sourcePath, "assets"), { recursive: true });
  const skill = "Fixture guide\r\n正文";
  await writeFile(join(root, binding.sourcePath, "SKILL.md"), skill);
  await writeFile(
    join(root, binding.sourcePath, "assets/raw.bin"),
    Buffer.from([0, 255]),
  );
  const archivePath = join(root, "archive.tar.gz");
  await create({ cwd: root, file: archivePath, gzip: true }, [
    binding.sourcePath,
  ]);
  body = await readFile(archivePath);
  const digest = createHash("sha256").update(body).digest("hex");
  const totalBytes = Buffer.byteLength(skill) + 2;
  await db.query(
    "INSERT INTO storages (id, user_id, org_id, name, s3_prefix, size, file_count) VALUES ($1, 'fixture', $2, $3, $4, $5, 2)",
    [storageId, orgId, binding.storageName, prefix, totalBytes],
  );
  for (const id of [binding.versionId, versionId, nextVersionId]) {
    await db.query(
      "INSERT INTO storage_versions (id, storage_id, s3_key, size, archive_size, file_count, created_by) VALUES ($1, $2, $3, $4, $5, 2, 'fixture')",
      [id, storageId, `${prefix}/${id}`, totalBytes, body.length],
    );
  }
  await db.query("UPDATE storages SET head_version_id = $1 WHERE id = $2", [
    versionId,
    storageId,
  ]);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === "string")
    throw new Error("Missing fixture endpoint");
  const credentials = join(root, "database-url");
  await writeFile(credentials, connection, { mode: 0o600 });
  const env = {
    ...process.env,
    DATABASE_URL_FILE: credentials,
    R2_ENDPOINT: `http://127.0.0.1:${endpoint.port}`,
    R2_ACCESS_KEY_ID: "fixture",
    R2_SECRET_ACCESS_KEY: "fixture",
    R2_USER_STORAGES_BUCKET_NAME: "test",
  };
  let sequence = 0;
  async function invoke(
    selection: string,
    expectFailure = false,
    extra: string[] = [],
  ) {
    const output = join(root, `receipt-${++sequence}.json`);
    const args = [
      "--import",
      "tsx",
      "scripts/migrations/028-registry-resource-bundles/inventory.ts",
      "--resource-id",
      binding!.id,
      "--selection",
      selection,
      "--output",
      output,
      ...extra,
    ];
    const result = promisify(execFile)(process.execPath, args, { env });
    if (expectFailure) await assert.rejects(result);
    else await result;
    return output;
  }

  const receipt = JSON.parse(await readFile(await invoke("latest"), "utf8"));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.rows.length, 1);
  assert.deepEqual(receipt.rows[0].archive, {
    format: "registry-tar-gzip-v1",
    sha256: digest,
    archiveBytes: body.length,
  });
  assert.equal(receipt.rows[0].source.versionId, versionId);
  assert.equal(receipt.rows[0].fileCount, 2);
  assert.equal(receipt.rows[0].totalBytes, totalBytes);
  assert.equal(
    receipt.rows[0].objectKey,
    `registry-archives/v1/${digest}.tar.gz`,
  );
  assert.equal(
    (
      await db.query("SELECT head_version_id FROM storages WHERE id = $1", [
        storageId,
      ])
    ).rows[0].head_version_id,
    versionId,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM registry_resource_archives WHERE resource_id = $1",
        [binding.id],
      )
    ).rows[0].n,
    0,
  );

  const pinned = JSON.parse(
    await readFile(await invoke("pinned", true), "utf8"),
  );
  assert.equal(pinned.complete, false);
  assert.match(pinned.failures[0].classification, /digest mismatch/u);
  moveHead = true;
  const changed = JSON.parse(
    await readFile(await invoke("latest", true), "utf8"),
  );
  assert.equal(changed.complete, false);
  assert.equal(
    changed.failures[0].classification,
    "SourceChangedDuringInventory",
  );
  await invoke("latest", true, ["--migrate"]);

  await db.query(
    "INSERT INTO registry_resource_archives (resource_id, sha256, archive_bytes, version_id, file_count, total_bytes) VALUES ($1, $2, $3, $4, 2, $5)",
    [binding.id, digest, body.length, versionId, totalBytes],
  );
  await assert.rejects(
    db.query(
      "INSERT INTO registry_resource_heads (resource_id, sha256) VALUES ($1, $2)",
      [binding.id, "0".repeat(64)],
    ),
  );
  await db.query(
    "INSERT INTO registry_resource_heads (resource_id, sha256) VALUES ($1, $2)",
    [binding.id, digest],
  );
  await db.query("UPDATE storages SET head_version_id = NULL WHERE id = $1", [
    storageId,
  ]);
  await db.query("DELETE FROM storage_versions WHERE storage_id = $1", [
    storageId,
  ]);
  await db.query("DELETE FROM storages WHERE id = $1", [storageId]);
  const surviving = await db.query(
    "SELECT a.sha256 FROM registry_resource_archives a JOIN registry_resource_heads h USING (resource_id, sha256) WHERE a.resource_id = $1",
    [binding.id],
  );
  assert.deepEqual(surviving.rows, [{ sha256: digest }]);
  process.stdout.write(
    "Registry inventory CLI and Storage-independent schema passed\n",
  );
} finally {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        return error ? reject(error) : resolve();
      });
    });
  }
  if (resourceId) {
    await db.query(
      "DELETE FROM registry_resource_heads WHERE resource_id = $1",
      [resourceId],
    );
    await db.query(
      "DELETE FROM registry_resource_archives WHERE resource_id = $1",
      [resourceId],
    );
  }
  await db.query("UPDATE storages SET head_version_id = NULL WHERE id = $1", [
    storageId,
  ]);
  await db.query("DELETE FROM storage_versions WHERE storage_id = $1", [
    storageId,
  ]);
  await db.query("DELETE FROM storages WHERE id = $1", [storageId]);
  await db.end();
  await rm(root, { recursive: true, force: true });
}
