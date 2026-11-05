import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Client } from "pg";
import { create } from "tar";
import {
  prepareContentBundle,
  contentBundleKey,
} from "@okouai/core/content-bundle";
import { getCustomConnectorSkillStorageName } from "@okouai/core/storage-names";
import {
  computeContentHashFromHashes,
  hashFileContent,
} from "@okouai/api-contracts/contracts/storage-content-hash";
import { planSchema, sha256 } from "./command";

export async function fixture() {
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
  await db.connect();
  const root = await mkdtemp(join(tmpdir(), "connector-skill-backfill-test-"));
  const id = randomUUID(),
    storageId = randomUUID(),
    orgId = `fixture-${id}`;
  const prefix = `fixture/${id}`;
  const body = Buffer.from(
    "---\nname: historical-feishu\ndescription: Original authored metadata\n---\n\nOriginal body\r\n技能校验\n",
  );
  const versionFor = (content: Buffer) => {
    return computeContentHashFromHashes(storageId, [
      {
        path: "SKILL.md",
        hash: hashFileContent(content),
        size: content.length,
      },
    ]);
  };
  const versionId = versionFor(body),
    nextBody = Buffer.from("Updated authored Skill\n"),
    nextVersionId = versionFor(nextBody);
  await writeFile(join(root, "SKILL.md"), body);
  await chmod(join(root, "SKILL.md"), 0o644);
  const archivePath = join(root, "legacy.tar.gz");
  await create(
    {
      cwd: root,
      file: archivePath,
      gzip: true,
      mtime: new Date("2020-01-02T03:04:05Z"),
    },
    ["SKILL.md"],
  );
  const archive = await readFile(archivePath);
  const canonical = await prepareContentBundle([
    { path: "SKILL.md", content: body, mode: 0o644 },
  ]);
  const next = await prepareContentBundle([
    { path: "SKILL.md", content: nextBody, mode: 0o644 },
  ]);
  await db.query(
    "INSERT INTO storages(id,user_id,org_id,name,s3_prefix) VALUES($1,'fixture',$2,$3,$4)",
    [storageId, orgId, getCustomConnectorSkillStorageName(id), prefix],
  );
  for (const [version, content, bytes] of [
    [versionId, body, archive],
    [nextVersionId, nextBody, next.archive],
  ] as const) {
    await db.query(
      "INSERT INTO storage_versions(id,storage_id,s3_key,size,file_count,archive_size,created_by) VALUES($1,$2,$3,$4,1,$5,'fixture')",
      [
        version,
        storageId,
        `${prefix}/${version}`,
        content.length,
        bytes.length,
      ],
    );
  }
  await db.query("UPDATE storages SET head_version_id=$1 WHERE id=$2", [
    versionId,
    storageId,
  ]);
  await db.query(
    `INSERT INTO org_custom_connectors(id,org_id,slug,display_name,auth_mode,prefix_templates,skill_markdown,skill_storage_version_id,created_by)
    VALUES($1,$2,$3,'Renamed integration','none','["https://fixture.example.test/"]','Original body',$4,'fixture')`,
    [id, orgId, `_fixture-${id}`, versionId],
  );
  const objects = new Map<string, Buffer>([
    [`${prefix}/${versionId}/archive.tar.gz`, archive],
    [`${prefix}/${nextVersionId}/archive.tar.gz`, next.archive],
  ]);
  let puts = 0,
    lostPut = false;
  let beforeRead: (() => Promise<void>) | undefined;
  async function respond(request: IncomingMessage, response: ServerResponse) {
    const path = decodeURIComponent(
      new URL(request.url ?? "/", "http://fixture.test").pathname,
    );
    const key = path.slice("/fixture/".length);
    if (!path.startsWith("/fixture/")) {
      response.writeHead(400).end();
      return;
    }
    if (request.method === "GET") {
      if (key.startsWith("bundles/v1/") && beforeRead) {
        const action = beforeRead;
        beforeRead = undefined;
        await action();
      }
      const bytes = objects.get(key);
      if (!bytes) {
        response
          .writeHead(404, { "content-type": "application/xml" })
          .end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      response
        .writeHead(200, {
          "content-length": bytes.length,
          "content-type": "application/gzip",
        })
        .end(bytes);
      return;
    }
    if (request.method === "PUT" && key.startsWith("bundles/v1/")) {
      if (request.headers["if-none-match"] !== "*" || objects.has(key)) {
        response.writeHead(412).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      puts += 1;
      if (lostPut) {
        lostPut = false;
        response.destroy();
      } else response.writeHead(200).end();
      return;
    }
    response.writeHead(400).end();
  }
  const server = createServer((request, response) => {
    respond(request, response).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    return server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  assert(bound && typeof bound !== "string");
  const endpoint = `http://127.0.0.1:${bound.port}`;
  let sequence = 0;
  async function run(args: string[], fail = false) {
    const output = join(root, `output-${sequence++}.json`);
    let failed = false;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/migrations/029-connector-skill-bundles/backfill.ts",
          ...args,
          "--output",
          output,
        ],
        {
          env: {
            PATH: process.env.PATH,
            DATABASE_URL: connection,
            R2_ENDPOINT: endpoint,
            R2_USER_STORAGES_BUCKET_NAME: "fixture",
            R2_ACCESS_KEY_ID: "fixture",
            R2_SECRET_ACCESS_KEY: "fixture",
          },
        },
      );
    } catch {
      failed = true;
    }
    assert.equal(failed, fail, `Unexpected CLI outcome; inspect ${output}`);
    return output;
  }
  async function row() {
    return (
      await db.query(
        "SELECT to_jsonb(c)-'skill_content_bundle'-'skill_content_bundle_source_version_id' AS owner, xmin::text, skill_content_bundle AS bundle, skill_content_bundle_source_version_id AS source FROM org_custom_connectors c WHERE id=$1",
        [id],
      )
    ).rows[0];
  }
  return {
    db,
    root,
    id,
    orgId,
    versionId,
    nextVersionId,
    archive,
    objects,
    canonical,
    canonicalKey: contentBundleKey(canonical.descriptor.sha256),
    storageId,
    targetKey: contentBundleKey(sha256(archive)),
    puts: () => {
      return puts;
    },
    row,
    loseNextPut: () => {
      lostPut = true;
    },
    beforeNextTargetRead: (action: () => Promise<void>) => {
      beforeRead = action;
    },
    plan: (fail = false) => {
      return run(["--connector-id", id], fail);
    },
    readPlan: async (path: string) => {
      return planSchema.parse(JSON.parse(await readFile(path, "utf8")));
    },
    apply: async (path: string, fail = false, digest?: string) => {
      return run(
        [
          "--migrate",
          "--writers-drained",
          "--plan",
          path,
          "--approve-plan-sha256",
          digest ?? sha256(await readFile(path)),
        ],
        fail,
      );
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        return server.close((error) => {
          return error ? reject(error) : resolve();
        });
      });
      try {
        await db.query("DELETE FROM org_custom_connectors WHERE id=$1", [id]);
        await db.query("UPDATE storages SET head_version_id=NULL WHERE id=$1", [
          storageId,
        ]);
        await db.query("DELETE FROM storage_versions WHERE storage_id=$1", [
          storageId,
        ]);
        await db.query("DELETE FROM storages WHERE id=$1", [storageId]);
      } finally {
        await db.end();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
