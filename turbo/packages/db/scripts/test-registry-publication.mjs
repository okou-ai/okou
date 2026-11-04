import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const exec = promisify(execFile);
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.resolve(packageDir, "../../../.github/scripts/release");
const databaseUrl = process.env.DATABASE_URL;
if (
  !databaseUrl ||
  !["127.0.0.1", "localhost", "postgres"].includes(
    new URL(databaseUrl).hostname,
  )
) {
  throw new Error(
    "Registry publication integration requires an isolated local DATABASE_URL",
  );
}
const config = JSON.parse(
  await readFile(
    path.join(releaseDir, "presentation-template-release.json"),
    "utf8",
  ),
);
const root = await mkdtemp(path.join(tmpdir(), "registry-publication-"));
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const objects = new Map();
let interceptPut;
const server = createServer(async (request, response) => {
  try {
    const key = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname.slice(1),
    );
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.headers["if-none-match"], "*");
      if (objects.has(key)) {
        response
          .writeHead(412)
          .end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      objects.set(key, Buffer.concat(chunks));
      if (interceptPut && (await interceptPut(key, request))) return;
      response.writeHead(200).end();
      return;
    }
    const bytes = objects.get(key);
    if (!bytes) {
      response.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    assert.ok(["GET", "HEAD"].includes(request.method));
    response.writeHead(200, { "Content-Length": bytes.length });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const toolDir = path.join(root, "tool");
const toolModules = path.join(toolDir, "presentation-template-release");
await mkdir(toolModules, { recursive: true });
for (const entry of await readdir(
  path.join(releaseDir, "presentation-template-release"),
)) {
  if (entry.endsWith(".mjs"))
    await cp(
      path.join(releaseDir, "presentation-template-release", entry),
      path.join(toolModules, entry),
    );
}
for (const file of [
  "publish-presentation-template-archives.mjs",
  "presentation-template-release.json",
]) {
  await cp(path.join(releaseDir, file), path.join(toolDir, file));
}
await symlink(
  path.join(packageDir, "node_modules"),
  path.join(toolDir, "node_modules"),
  "dir",
);
const tool = path.join(toolDir, "publish-presentation-template-archives.mjs");
const baseEnv = {
  PATH: process.env.PATH,
  R2_ACCOUNT_ID: "fixture",
  R2_ENDPOINT: endpoint,
  R2_USER_STORAGES_BUCKET_NAME: "legacy",
  R2_ACCESS_KEY_ID: "fixture",
  R2_SECRET_ACCESS_KEY: "fixture",
  R2_PRIVATE_ARTIFACTS_BUCKET_NAME: "private",
  R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID: "fixture",
  R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY: "fixture",
};
const run = (args, env = baseEnv) =>
  exec(process.execPath, [tool, ...args], { env, maxBuffer: 2 * 1024 * 1024 });

async function build(label) {
  const source = path.join(root, `source-${label}`);
  const output = path.join(root, `output-${label}`);
  for (const release of config.templates) {
    const dir = path.join(source, release.slug);
    await mkdir(path.join(dir, "layouts"), { recursive: true });
    await mkdir(path.join(dir, "color-systems"), { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      `# ${label}\n${"Presentation guidance.\n".repeat(100)}`,
    );
    await writeFile(path.join(dir, "design-system.md"), "# Design system\n");
    await writeFile(
      path.join(dir, "layouts/shared-shell.html"),
      `<link href="../color-systems/${release.defaultColorSystem}.css">`,
    );
    await writeFile(
      path.join(dir, `color-systems/${release.defaultColorSystem}.css`),
      ":root { --background: white; }",
    );
  }
  await run([
    "build",
    "--source-dir",
    source,
    "--source-commit",
    "a".repeat(40),
    "--output-dir",
    output,
  ]);
  return {
    output,
    publication: JSON.parse(
      await readFile(path.join(output, "publication.json"), "utf8"),
    ),
  };
}

const schemas = [];
const roles = [];
async function fixture(initial) {
  objects.clear();
  interceptPut = undefined;
  const schema = `registry_pub_${randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  schemas.push(schema);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const sql = postgres(url.href, { max: 1, onnotice: () => {} });
  await sql.unsafe(`CREATE TABLE storages (
    id uuid PRIMARY KEY, name text NOT NULL, s3_prefix text NOT NULL,
    head_version_id varchar(64) NOT NULL, size bigint NOT NULL, file_count integer NOT NULL,
    updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE storage_versions (
    id varchar(64) PRIMARY KEY, storage_id uuid NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
    s3_key text NOT NULL, size bigint NOT NULL, archive_size bigint NOT NULL, file_count integer NOT NULL,
    message text, created_by text);`);
  const migration = await readFile(
    path.join(
      packageDir,
      "src/migrations/1519_registry_resource_bundle_preparation.sql",
    ),
    "utf8",
  );
  await sql.unsafe(migration.replaceAll('"public".', `"${schema}".`));
  for (const pkg of initial.publication.packages) {
    const prefix = `__system__/${pkg.storageId}`;
    const key = `${prefix}/${pkg.versionId}`;
    await sql`INSERT INTO storages (id,name,s3_prefix,head_version_id,size,file_count)
      VALUES (${pkg.storageId},${`registry-resource@${pkg.resourceId}`},${prefix},${pkg.versionId},${pkg.totalSize},${pkg.fileCount})`;
    await sql`INSERT INTO storage_versions (id,storage_id,s3_key,size,archive_size,file_count)
      VALUES (${pkg.versionId},${pkg.storageId},${key},${pkg.totalSize},${pkg.archive.byteSize},${pkg.fileCount})`;
    await sql`INSERT INTO registry_resource_archives (resource_id,sha256,archive_bytes,version_id,file_count,total_bytes)
      VALUES (${pkg.resourceId},${pkg.archive.sha256},${pkg.archive.byteSize},${pkg.versionId},${pkg.fileCount},${pkg.totalSize})`;
    await sql`INSERT INTO registry_resource_heads (resource_id,sha256) VALUES (${pkg.resourceId},${pkg.archive.sha256})`;
    const bytes = await readFile(path.join(initial.output, pkg.archive.path));
    objects.set(`legacy/${key}/archive.tar.gz`, bytes);
    objects.set(`private/${pkg.registryArchive.objectKey}`, bytes);
  }
  return { sql, schema, env: { ...baseEnv, DATABASE_URL: url.href } };
}

async function heads(sql) {
  return await sql`SELECT s.id, s.head_version_id, s.xmin::text AS storage_xmin,
    h.sha256, h.xmin::text AS head_xmin, h.updated_at
    FROM storages s JOIN registry_resource_heads h ON s.name = 'registry-resource@' || h.resource_id ORDER BY s.id`;
}

async function verify(f, bundle) {
  for (const pkg of bundle.publication.packages) {
    const [row] =
      await f.sql`SELECT a.version_id,a.archive_bytes,a.file_count,a.total_bytes,s.head_version_id
      FROM registry_resource_archives a JOIN registry_resource_heads h USING (resource_id,sha256)
      JOIN storages s ON s.name = 'registry-resource@' || h.resource_id WHERE a.resource_id = ${pkg.resourceId}`;
    assert.equal(row.version_id, pkg.versionId);
    assert.equal(row.head_version_id, pkg.versionId);
    assert.equal(Number(row.archive_bytes), pkg.archive.byteSize);
    assert.equal(row.file_count, pkg.fileCount);
    assert.equal(Number(row.total_bytes), pkg.totalSize);
    const bytes = await readFile(path.join(bundle.output, pkg.archive.path));
    assert.deepEqual(
      objects.get(`private/${pkg.registryArchive.objectKey}`),
      bytes,
    );
    assert.deepEqual(
      objects.get(
        `legacy/__system__/${pkg.storageId}/${pkg.versionId}/archive.tar.gz`,
      ),
      bytes,
    );
  }
}

try {
  const initial = await build("initial");
  const next = await build("next");
  const newer = await build("newer");
  const firstKey = `private/${next.publication.packages[0].registryArchive.objectKey}`;
  const f = await fixture(initial);
  try {
    let responseLost = false;
    interceptPut = (key, request) => {
      if (key !== firstKey || responseLost) return false;
      responseLost = true;
      request.socket.destroy();
      return true;
    };
    await run(["publish", "--output-dir", next.output], f.env);
    await verify(f, next);
    assert.ok(responseLost);
    const before = await heads(f.sql);
    const retainedObjects = new Map(objects);
    await run(["publish", "--output-dir", next.output], f.env);
    assert.deepEqual(await heads(f.sql), before);
    assert.deepEqual(objects, retainedObjects);
    const [retained] =
      await f.sql`SELECT count(*)::int AS count FROM registry_resource_archives`;
    assert.equal(retained.count, initial.publication.packages.length * 2);
    console.log(
      "PASS original bytes in both locations, uncertain PUT recovery, retained fixed archives and idempotent rerun",
    );
  } finally {
    await f.sql.end();
  }

  const conflict = await fixture(initial);
  try {
    const originalHeads = await heads(conflict.sql);
    objects.set(firstKey, Buffer.from("conflicting immutable object"));
    await assert.rejects(
      run(["publish", "--output-dir", next.output], conflict.env),
      (e) => /immutable registry object conflicts/.test(e.stderr),
    );
    assert.equal(
      objects.get(firstKey).toString(),
      "conflicting immutable object",
    );
    assert.deepEqual(await heads(conflict.sql), originalHeads);
    console.log(
      "PASS conflicting immutable object leaves both published HEADs unchanged",
    );
  } finally {
    await conflict.sql.end();
  }

  const interrupted = await fixture(initial);
  try {
    const role = `registry_writer_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'registry-publication-fixture'`,
    );
    roles.push(role);
    await admin`GRANT USAGE ON SCHEMA ${admin(interrupted.schema)} TO ${admin(role)}`;
    for (const table of [
      "storages",
      "storage_versions",
      "registry_resource_archives",
      "registry_resource_heads",
    ]) {
      await admin`GRANT SELECT ON ${admin(`${interrupted.schema}.${table}`)} TO ${admin(role)}`;
    }
    for (const table of ["storage_versions", "registry_resource_archives"]) {
      await admin`GRANT INSERT ON ${admin(`${interrupted.schema}.${table}`)} TO ${admin(role)}`;
    }
    await admin`GRANT UPDATE ON ${admin(`${interrupted.schema}.storages`)} TO ${admin(role)}`;
    const url = new URL(interrupted.env.DATABASE_URL);
    url.username = role;
    url.password = "registry-publication-fixture";
    const writerEnv = { ...interrupted.env, DATABASE_URL: url.href };
    await assert.rejects(
      run(["publish", "--output-dir", next.output], writerEnv),
      (error) => /permission denied/.test(error.stderr),
    );
    const [partial] =
      await interrupted.sql`SELECT s.head_version_id,h.sha256 FROM storages s
      JOIN registry_resource_heads h ON s.name = 'registry-resource@' || h.resource_id
      WHERE h.resource_id = ${next.publication.packages[0].resourceId}`;
    assert.equal(
      partial.head_version_id,
      next.publication.packages[0].versionId,
    );
    assert.equal(
      partial.sha256,
      initial.publication.packages[0].archive.sha256,
    );
    await admin`GRANT UPDATE ON ${admin(`${interrupted.schema}.registry_resource_heads`)} TO ${admin(role)}`;
    const retainedObjects = new Map(objects);
    await run(["publish", "--output-dir", next.output], writerEnv);
    await verify(interrupted, next);
    assert.deepEqual(objects, retainedObjects);
    console.log(
      "PASS interrupted dual publication resumes the same verified bundle without rewriting objects",
    );
  } finally {
    await interrupted.sql.end();
  }

  const concurrent = await fixture(initial);
  try {
    let releaseFirst;
    let observedFirst;
    const firstObserved = new Promise((resolve) => {
      observedFirst = resolve;
    });
    const firstReleased = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    interceptPut = async (key) => {
      if (key !== firstKey) return false;
      observedFirst();
      await firstReleased;
      return false;
    };
    const first = run(["publish", "--output-dir", next.output], concurrent.env);
    const outcome = first.then(
      () => ({ succeeded: true }),
      (error) => ({ succeeded: false, error }),
    );
    try {
      await Promise.race([
        firstObserved,
        outcome.then((result) => {
          if (!result.succeeded) throw result.error;
          throw new Error(
            "First publisher finished without reaching the object boundary",
          );
        }),
      ]);
      await run(["publish", "--output-dir", newer.output], concurrent.env);
      await verify(concurrent, newer);
    } finally {
      releaseFirst();
      await outcome;
    }
    const result = await outcome;
    assert.equal(result.succeeded, false);
    assert.match(
      result.error.stderr,
      /source changed before registry archive registration/,
    );
    await verify(concurrent, newer);
    console.log(
      "PASS stale concurrent publisher cannot overwrite the completed publication",
    );
  } finally {
    await concurrent.sql.end();
  }
} finally {
  interceptPut = undefined;
  await new Promise((resolve) => server.close(resolve));
  for (const schema of schemas)
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
  for (const role of roles) await admin`DROP ROLE ${admin(role)}`;
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
