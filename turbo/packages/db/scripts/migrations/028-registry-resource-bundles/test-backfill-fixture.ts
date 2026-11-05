import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { inspectRegistryResourceArchive } from "@okouai/core/registry-resource-archive";
import { planSchema, sha256 } from "./backfill-plan";

export async function fixture() {
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("Disposable DATABASE_URL required");
  const address = new URL(connection);
  const local = ["localhost", "127.0.0.1"].includes(address.hostname);
  const ci =
    address.hostname === "postgres" &&
    address.pathname === "/migration_test_existing";
  if (
    (!local && !ci) ||
    address.searchParams.has("host") ||
    address.searchParams.has("port")
  ) {
    throw new Error(
      "Disposable local or migration-consistency database required",
    );
  }
  const db = new Client({ connectionString: connection });
  await db.connect();
  const root = await mkdtemp(join(tmpdir(), "registry-backfill-test-"));
  const candidates = listPrivateRegistryResourceArchives().filter((entry) => {
    return entry.latest;
  });
  const used = await db.query(
    "SELECT id FROM storage_versions WHERE id = ANY($1::text[])",
    [
      candidates.map((entry) => {
        return entry.versionId;
      }),
    ],
  );
  const binding = candidates.find((entry) => {
    return !used.rows.some((row) => {
      return row.id === entry.versionId;
    });
  });
  if (!binding) throw new Error("No unused fixture anchor");
  const storageId = randomUUID();
  const prefix = `registry-backfill-test/${storageId}`;
  const versionId = sha256(storageId);
  const nextVersionId = sha256(prefix);
  await mkdir(join(root, binding.sourcePath, "assets"), { recursive: true });
  const content = "Fixture guide\r\n正文";
  await writeFile(join(root, binding.sourcePath, "SKILL.md"), content);
  await writeFile(
    join(root, binding.sourcePath, "assets/raw.bin"),
    Buffer.from([0, 255]),
  );
  const archivePath = join(root, "archive.tar.gz");
  await create({ cwd: root, file: archivePath, gzip: true }, [
    binding.sourcePath,
  ]);
  const body = await readFile(archivePath);
  const inspected = inspectRegistryResourceArchive(
    body,
    undefined,
    binding.sourcePath,
  );
  await db.query(
    "INSERT INTO storages (id, user_id, org_id, name, s3_prefix, size, file_count) VALUES ($1, 'fixture', $2, $3, $4, $5, $6)",
    [
      storageId,
      prefix,
      binding.storageName,
      prefix,
      inspected.totalBytes,
      inspected.fileCount,
    ],
  );
  for (const id of [binding.versionId, versionId, nextVersionId]) {
    await db.query(
      "INSERT INTO storage_versions (id, storage_id, s3_key, size, archive_size, file_count, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'fixture')",
      [
        id,
        storageId,
        `${prefix}/${id}`,
        inspected.totalBytes,
        body.length,
        inspected.fileCount,
      ],
    );
  }
  await db.query("UPDATE storages SET head_version_id = $1 WHERE id = $2", [
    versionId,
    storageId,
  ]);
  const objects = new Map<string, Buffer>();
  let puts = 0;
  let losePutResponse = false;
  let beforeTargetRead: (() => Promise<void>) | undefined;
  async function respond(request: IncomingMessage, response: ServerResponse) {
    const path = decodeURIComponent(
      new URL(request.url ?? "/", "http://fixture.test").pathname,
    );
    if (
      request.method === "GET" &&
      path.startsWith(`/source/${prefix}/`) &&
      path.endsWith("/archive.tar.gz")
    ) {
      response.writeHead(200, { "content-length": body.length });
      response.end(body);
      return;
    }
    if (!path.startsWith("/target/registry-archives/v1/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const key = path.slice("/target/".length);
    if (request.method === "GET") {
      const hook = beforeTargetRead;
      beforeTargetRead = undefined;
      await hook?.();
      const found = objects.get(key);
      if (found) {
        response.writeHead(200, { "content-length": found.length });
        response.end(found);
      } else {
        response.writeHead(404, { "content-type": "application/xml" });
        response.end("<Error><Code>NoSuchKey</Code></Error>");
      }
      return;
    }
    if (request.method === "PUT") {
      puts++;
      assert.equal(request.headers["if-none-match"], "*");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (objects.has(key)) {
        response.writeHead(412);
        response.end();
        return;
      }
      objects.set(key, Buffer.concat(chunks));
      if (losePutResponse) {
        losePutResponse = false;
        response.destroy();
        return;
      }
      response.writeHead(200);
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  }
  const server = createServer((request, response) => {
    respond(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === "string")
    throw new Error("Missing fixture endpoint");
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: connection,
    R2_ENDPOINT: `http://127.0.0.1:${endpoint.port}`,
    R2_ACCESS_KEY_ID: "fixture",
    R2_SECRET_ACCESS_KEY: "fixture",
    R2_USER_STORAGES_BUCKET_NAME: "source",
    REGISTRY_R2_ENDPOINT: `http://127.0.0.1:${endpoint.port}`,
    REGISTRY_R2_ACCESS_KEY_ID: "fixture",
    REGISTRY_R2_SECRET_ACCESS_KEY: "fixture",
    REGISTRY_ARCHIVES_BUCKET_NAME: "target",
  };
  let sequence = 0;
  const invoke = async (script: string, args: string[], failure = false) => {
    const output = join(root, `receipt-${++sequence}.json`);
    const result = promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        `scripts/migrations/028-registry-resource-bundles/${script}.ts`,
        ...args,
        "--output",
        output,
      ],
      { env, timeout: 60_000 },
    );
    if (failure) await assert.rejects(result);
    else await result;
    return output;
  };
  const inventory = () => {
    return invoke("inventory", [
      "--resource-id",
      binding.id,
      "--selection",
      "latest",
    ]);
  };
  const plan = async (file: string, failure = false) => {
    return invoke("backfill", ["--inventory", file], failure);
  };
  const apply = async (file: string, failure = false, hash?: string) => {
    return invoke(
      "backfill",
      [
        "--apply",
        "--plan",
        file,
        "--approve-plan-sha256",
        hash ?? sha256(await readFile(file)),
      ],
      failure,
    );
  };
  const readPlan = async (file: string) => {
    return planSchema.parse(JSON.parse(await readFile(file, "utf8")));
  };
  const head = async () => {
    return (
      await db.query(
        "SELECT sha256, xmin::text, updated_at::text FROM registry_resource_heads WHERE resource_id = $1",
        [binding.id],
      )
    ).rows[0];
  };
  const clear = async () => {
    await db.query(
      "DELETE FROM registry_resource_heads WHERE resource_id = $1",
      [binding.id],
    );
    await db.query(
      "DELETE FROM registry_resource_archives WHERE resource_id = $1",
      [binding.id],
    );
    objects.clear();
  };
  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      return server.close((error) => {
        return error ? reject(error) : resolve();
      });
    });
    try {
      await clear();
      await db.query(
        "UPDATE storages SET head_version_id = NULL WHERE id = $1",
        [storageId],
      );
      await db.query("DELETE FROM storages WHERE id = $1", [storageId]);
    } finally {
      await db.end();
      await rm(root, { recursive: true, force: true });
    }
  };
  return {
    db,
    binding,
    storageId,
    versionId,
    nextVersionId,
    body,
    inspected,
    objects,
    inventory,
    plan,
    apply,
    readPlan,
    head,
    clear,
    close,
    puts: () => {
      return puts;
    },
    loseNextPutResponse: () => {
      losePutResponse = true;
    },
    beforeNextTargetRead: (hook: () => Promise<void>) => {
      beforeTargetRead = hook;
    },
  };
}
