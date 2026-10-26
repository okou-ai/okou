import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { create } from "tar";
import {
  array,
  literal,
  record,
  string,
  object as zObject,
  unknown as zUnknown,
} from "zod";
import {
  computeContentHashFromHashes,
  hashFileContent,
} from "@okouai/api-contracts/contracts/storage-content-hash";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A disposable DATABASE_URL is required");
const databaseAddress = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1"].includes(databaseAddress.hostname) &&
  !(
    databaseAddress.hostname === "postgres" &&
    databaseAddress.pathname === "/migration_test_existing"
  )
)
  throw new Error(
    "A disposable local or migration-consistency database is required",
  );
const db = new Client({ connectionString: databaseUrl });
await db.connect();
const root = await mkdtemp(join(tmpdir(), "presentation-copy-test-"));
const objects = new Map<string, Buffer>();
let putCount = 0;
let beforePut: (() => Promise<void>) | undefined;
let failPut = false;
async function handle(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const key = decodeURIComponent(
    (request.url ?? "").split("?")[0] ?? "",
  ).replace(/^\/test\//u, "");
  if (request.method === "PUT") {
    putCount++;
    const callback = beforePut;
    beforePut = undefined;
    await callback?.();
    if (failPut) {
      response.writeHead(500);
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
    response.end();
    return;
  }
  const object = objects.get(key);
  if (!object) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-length": object.length });
  response.end(object);
}
const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    response.destroy(
      error instanceof Error ? error : new Error("Fixture failed"),
    );
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Expected local S3 address");
const credential = join(root, "database-url");
await writeFile(credential, databaseUrl, { mode: 0o600 });
const run = async (id: string, ...args: string[]) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/migrations/025-presentation-template-copy/copy.ts",
      "--template-id",
      id,
      ...args,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL_FILE: credential,
        R2_ENDPOINT: `http://127.0.0.1:${address.port}`,
        R2_USER_STORAGES_BUCKET_NAME: "test",
        R2_ACCESS_KEY_ID: "local",
        R2_SECRET_ACCESS_KEY: "local",
      },
    },
  );
  return record(string(), zUnknown()).parse(
    JSON.parse(stdout.trim().split("\n").at(-1) ?? ""),
  );
};
const expectFailure = async (id: string, classification: string) => {
  await assert.rejects(run(id, "--migrate"), (error: unknown) => {
    const failed = zObject({ code: literal(2), stdout: string() }).safeParse(
      error,
    );
    if (!failed.success) return false;
    const summary = zObject({
      attention: array(
        zObject({ templateId: string(), classification: string() }),
      ),
    }).parse(JSON.parse(failed.data.stdout.trim().split("\n").at(-1) ?? ""));
    return summary.attention.some((item) => {
      return item.templateId === id && item.classification === classification;
    });
  });
};
const orgIds: string[] = [];
async function seed(visibility: "private" | "public" = "private") {
  const id = randomUUID(),
    storageId = randomUUID(),
    orgId = `copy-${randomUUID()}`;
  orgIds.push(orgId);
  await db.query(
    `INSERT INTO presentation_templates (id, org_id, owner_user_id, visibility, title,
    source_storage_key, source_filename, page_keys, created_by, updated_by, created_at, updated_at)
    VALUES ($1,$2,'owner',$3,'Original deck','uploads/source','deck.pptx',ARRAY['uploads/cover','uploads/page2'],
      'creator','editor','2026-09-01 01:02:03','2026-10-01 04:05:06')`,
    [id, orgId, visibility],
  );
  const content = Buffer.from(
    "# Reusable deck\nUse ./references.md for layouts.\n",
  );
  const reference = Buffer.from("Layout instructions\n");
  const files = [
    { path: "SKILL.md", hash: hashFileContent(content), size: content.length },
    {
      path: "references.md",
      hash: hashFileContent(reference),
      size: reference.length,
    },
  ];
  const versionId = computeContentHashFromHashes(storageId, files);
  const s3Prefix = `historical-prefix/${storageId}`;
  const s3Key = `${s3Prefix}/${versionId}`;
  const directory = join(root, id);
  await mkdir(directory);
  await writeFile(join(directory, "SKILL.md"), content);
  await writeFile(join(directory, "references.md"), reference);
  await create(
    { cwd: directory, file: join(directory, "archive.tar.gz"), gzip: true },
    ["SKILL.md", "references.md"],
  );
  const archive = await readFile(join(directory, "archive.tar.gz"));
  const size = content.length + reference.length;
  const manifest = {
    version: versionId,
    createdAt: new Date(0).toISOString(),
    totalSize: size,
    fileCount: files.length,
    files,
  };
  objects.set(`${s3Key}/archive.tar.gz`, archive);
  objects.set(`${s3Key}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
  await db.query(
    `INSERT INTO storages (id, org_id, user_id, name, s3_prefix, size, file_count)
    VALUES ($1,$2,'__org__',$3,$4,$5,2)`,
    [storageId, orgId, `presentation-template@${id}`, s3Prefix, size],
  );
  await db.query(
    `INSERT INTO storage_versions (id, storage_id, s3_key, size, archive_size, file_count, created_by)
    VALUES ($1,$2,$3,$4,$5,2,'user')`,
    [versionId, storageId, s3Key, size, archive.length],
  );
  await db.query("UPDATE storages SET head_version_id = $1 WHERE id = $2", [
    versionId,
    storageId,
  ]);
  // Same name in a different user scope must not be copied or renamed.
  await db.query(
    `INSERT INTO storages (org_id, user_id, name, s3_prefix)
    VALUES ($1,'another-user',$2,'unrelated')`,
    [orgId, `presentation-template@${id}`],
  );
  return { id, orgId, storageId, versionId, s3Key, manifest, archive };
}
async function snapshot(orgId: string) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "presentation_templates",
    "user_templates",
    "storages",
    "storage_versions",
  ]) {
    const query =
      table === "storage_versions"
        ? "SELECT to_jsonb(v) AS row FROM storage_versions v JOIN storages s ON s.id = v.storage_id WHERE s.org_id = $1 ORDER BY v.id"
        : `SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id = $1 ORDER BY id`;
    const rows = await db.query<{ row: unknown }>(query, [orgId]);
    result[table] = rows.rows.map(({ row }) => {
      return row;
    });
  }
  return result;
}
try {
  for (const visibility of ["private", "public"] as const) {
    const fixture = await seed(visibility);
    const before = await snapshot(fixture.orgId);
    const sourceObjects = new Map(objects);
    const writesBefore = putCount;
    assert.equal((await run(fixture.id)).ready, 1);
    assert.equal(putCount, writesBefore);
    assert.deepEqual(await snapshot(fixture.orgId), before);
    assert.equal((await run(fixture.id, "--migrate")).copied, 1);
    const after = await snapshot(fixture.orgId);
    assert.deepEqual(
      after.presentation_templates,
      before.presentation_templates,
    );
    for (const key of ["storages", "storage_versions"]) {
      for (const row of before[key] ?? [])
        assert.ok(
          after[key]?.some((value) => {
            return JSON.stringify(value) === JSON.stringify(row);
          }),
        );
    }
    const original = record(string(), zUnknown()).parse(
      before.presentation_templates?.[0],
    );
    const {
      aspect_ratio: aspectRatio,
      page_keys: pageKeys,
      ...metadata
    } = original;
    assert.equal(aspectRatio, null);
    assert.deepEqual(after.user_templates, [
      {
        ...metadata,
        visibility: visibility === "public" ? "organization" : "private",
        manifest: { kind: "presentation", pageKeys },
      },
    ]);
    for (const [key, bytes] of sourceObjects)
      assert.deepEqual(objects.get(key), bytes);
    const target = zObject({
      id: string(),
      head_version_id: string(),
      s3_prefix: string(),
    }).parse(
      (
        await db.query(
          "SELECT * FROM storages WHERE org_id = $1 AND name = $2",
          [fixture.orgId, `user-template@${fixture.id}`],
        )
      ).rows[0],
    );
    assert.notEqual(target.id, fixture.storageId);
    assert.equal(
      target.head_version_id,
      computeContentHashFromHashes(target.id, fixture.manifest.files),
    );
    assert.equal(target.s3_prefix, `${fixture.orgId}/${target.id}`);
    assert.deepEqual(
      objects.get(
        `${target.s3_prefix}/${target.head_version_id}/archive.tar.gz`,
      ),
      fixture.archive,
    );
    assert.deepEqual(
      JSON.parse(
        objects
          .get(`${target.s3_prefix}/${target.head_version_id}/manifest.json`)
          ?.toString() ?? "",
      ),
      { ...fixture.manifest, version: target.head_version_id },
    );
    // The two catalogs can evolve independently; reruns must not undo edits.
    await db.query(
      "UPDATE user_templates SET title = 'New catalog edit' WHERE id = $1",
      [fixture.id],
    );
    await db.query(
      "UPDATE presentation_templates SET title = 'Old catalog edit' WHERE id = $1",
      [fixture.id],
    );
    const edited = await snapshot(fixture.orgId);
    const writesAfter = putCount;
    assert.equal((await run(fixture.id, "--migrate")).existing, 1);
    assert.deepEqual(await snapshot(fixture.orgId), edited);
    assert.equal(putCount, writesAfter);
  }
  for (const scenario of [
    "missing-head",
    "wrong-head",
    "manifest",
    "template-conflict",
    "storage-conflict",
    "destination-raced",
    "source-changed",
    "upload-failed",
  ]) {
    const fixture = await seed();
    let classification: string;
    let concurrentState: Awaited<ReturnType<typeof snapshot>> | undefined;
    switch (scenario) {
      case "missing-head":
        await db.query(
          "UPDATE storages SET head_version_id = NULL WHERE id = $1",
          [fixture.storageId],
        );
        classification = "MissingCommittedSourcePackage";
        break;
      case "wrong-head": {
        const other = await seed();
        await db.query(
          "UPDATE storages SET head_version_id = $1 WHERE id = $2",
          [other.versionId, fixture.storageId],
        );
        classification = "MissingCommittedSourcePackage";
        break;
      }
      case "manifest":
        objects.set(
          `${fixture.s3Key}/manifest.json`,
          Buffer.from(
            JSON.stringify({ ...fixture.manifest, version: "wrong" }),
          ),
        );
        classification = "PackageManifestMismatch";
        break;
      case "template-conflict":
        await db.query(
          `INSERT INTO user_templates (id, org_id, owner_user_id, title, source_storage_key, source_filename, manifest, created_by, updated_by)
          VALUES ($1,$2,'owner','Keep existing','source','document.docx','{"kind":"document","pageCount":2}','owner','owner')`,
          [fixture.id, fixture.orgId],
        );
        classification = "DestinationConflict";
        break;
      case "storage-conflict":
        await db.query(
          "INSERT INTO storages (org_id, user_id, name, s3_prefix) VALUES ($1,'__org__',$2,'keep-prefix')",
          [fixture.orgId, `user-template@${fixture.id}`],
        );
        classification = "DestinationStorageConflict";
        break;
      case "source-changed":
        beforePut = async () => {
          await db.query(
            "UPDATE presentation_templates SET title = 'Concurrent edit' WHERE id = $1",
            [fixture.id],
          );
        };
        classification = "SourceChanged";
        break;
      case "destination-raced":
        beforePut = async () => {
          await db.query(
            `INSERT INTO user_templates (id, org_id, owner_user_id, title, source_storage_key, source_filename, manifest, created_by, updated_by)
              VALUES ($1,$2,'owner','Concurrent template','source','document.docx','{"kind":"document"}','owner','owner')`,
            [fixture.id, fixture.orgId],
          );
          concurrentState = await snapshot(fixture.orgId);
        };
        classification = "PostgresError";
        break;
      case "upload-failed":
        failPut = true;
        classification = "Unknown";
        break;
      default:
        throw new Error("Unexpected scenario");
    }
    const before = await snapshot(fixture.orgId);
    const writesBefore = putCount;
    await expectFailure(fixture.id, classification);
    const after = await snapshot(fixture.orgId);
    if (scenario === "source-changed") {
      for (const key of ["user_templates", "storages", "storage_versions"])
        assert.deepEqual(after[key], before[key]);
    } else assert.deepEqual(after, concurrentState ?? before);
    if (scenario === "upload-failed") {
      assert.equal(putCount, writesBefore + 1);
      failPut = false;
    } else if (
      scenario !== "source-changed" &&
      scenario !== "destination-raced"
    )
      assert.equal(putCount, writesBefore);
  }
  console.log(
    "Presentation copy CLI: legacy preservation, independent packages, replay and failure isolation passed",
  );
} finally {
  // Only this test's random organizations are removed, including failed cases.
  await db.query("DELETE FROM user_templates WHERE org_id = ANY($1::text[])", [
    orgIds,
  ]);
  await db.query(
    "DELETE FROM presentation_templates WHERE org_id = ANY($1::text[])",
    [orgIds],
  );
  await db.query(
    "UPDATE storages SET head_version_id = NULL WHERE org_id = ANY($1::text[])",
    [orgIds],
  );
  await db.query("DELETE FROM storages WHERE org_id = ANY($1::text[])", [
    orgIds,
  ]);
  await db.end();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await rm(root, { recursive: true, force: true });
}
