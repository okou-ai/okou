import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import console from "node:console";
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
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
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
const requests = [];
async function handleRequest(request, response) {
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
}
const server = createServer((request, response) => {
  requests.push(
    handleRequest(request, response).catch((error) => {
      response.destroy(error);
    }),
  );
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => {
  return server.once("listening", resolve);
});
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
  R2_PRIVATE_ARTIFACTS_BUCKET_NAME: "private",
  R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID: "fixture",
  R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY: "fixture",
};
const run = (args, env = baseEnv) => {
  return exec(process.execPath, [tool, ...args], {
    env,
    maxBuffer: 2 * 1024 * 1024,
  });
};

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
async function legacyState(sql) {
  return {
    storages: await sql`SELECT *, xmin::text FROM storages ORDER BY id`,
    versions: await sql`SELECT *, xmin::text FROM storage_versions ORDER BY id`,
  };
}

async function fixture(initial, writableHeads = true) {
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
  const legacy = await legacyState(sql);
  const legacyObjects = new Map(
    [...objects].filter(([key]) => {
      return key.startsWith("legacy/");
    }),
  );
  const role = `registry_writer_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD 'registry-publication-fixture'`,
  );
  roles.push(role);
  await admin`GRANT USAGE ON SCHEMA ${admin(schema)} TO ${admin(role)}`;
  for (const table of [
    "registry_resource_archives",
    "registry_resource_heads",
  ]) {
    await admin`GRANT SELECT ON ${admin(`${schema}.${table}`)} TO ${admin(role)}`;
  }
  await admin`GRANT INSERT ON ${admin(`${schema}.registry_resource_archives`)} TO ${admin(role)}`;
  if (writableHeads) {
    await admin`GRANT UPDATE ON ${admin(`${schema}.registry_resource_heads`)} TO ${admin(role)}`;
  }
  url.username = role;
  url.password = "registry-publication-fixture";
  return {
    sql,
    schema,
    role,
    legacy,
    legacyObjects,
    env: { ...baseEnv, DATABASE_URL: url.href },
  };
}

async function heads(sql) {
  return await sql`SELECT resource_id, sha256, xmin::text, updated_at
    FROM registry_resource_heads ORDER BY resource_id`;
}

async function verifyLegacy(f) {
  assert.deepEqual(await legacyState(f.sql), f.legacy);
  for (const [key, value] of f.legacyObjects) {
    assert.deepEqual(objects.get(key), value);
  }
}

async function verify(f, bundle) {
  await verifyLegacy(f);
  for (const pkg of bundle.publication.packages) {
    const [row] =
      await f.sql`SELECT a.version_id,a.archive_bytes,a.file_count,a.total_bytes
      FROM registry_resource_archives a JOIN registry_resource_heads h USING (resource_id,sha256)
      WHERE a.resource_id = ${pkg.resourceId}`;
    assert.equal(row.version_id, pkg.versionId);
    assert.equal(Number(row.archive_bytes), pkg.archive.byteSize);
    assert.equal(row.file_count, pkg.fileCount);
    assert.equal(Number(row.total_bytes), pkg.totalSize);
    const bytes = await readFile(path.join(bundle.output, pkg.archive.path));
    assert.deepEqual(
      objects.get(`private/${pkg.registryArchive.objectKey}`),
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
      "PASS independent-only credentials and database grants, original private bytes, uncertain PUT recovery, retained archives and idempotent rerun",
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
      (e) => {
        return /immutable registry object conflicts/.test(e.stderr);
      },
    );
    assert.equal(
      objects.get(firstKey).toString(),
      "conflicting immutable object",
    );
    assert.deepEqual(await heads(conflict.sql), originalHeads);
    console.log("PASS conflicting immutable object preserves published HEADs");
  } finally {
    await conflict.sql.end();
  }

  const interrupted = await fixture(initial, false);
  try {
    const before = await heads(interrupted.sql);
    await assert.rejects(
      run(["publish", "--output-dir", next.output], interrupted.env),
      (error) => {
        return /permission denied/.test(error.stderr);
      },
    );
    assert.deepEqual(await heads(interrupted.sql), before);
    const [partial] =
      await interrupted.sql`SELECT version_id FROM registry_resource_archives
      WHERE resource_id = ${next.publication.packages[0].resourceId}
        AND sha256 = ${next.publication.packages[0].archive.sha256}`;
    assert.equal(partial.version_id, next.publication.packages[0].versionId);
    await admin`GRANT UPDATE ON ${admin(`${interrupted.schema}.registry_resource_heads`)} TO ${admin(interrupted.role)}`;
    const retainedObjects = new Map(objects);
    await run(["publish", "--output-dir", next.output], interrupted.env);
    await verify(interrupted, next);
    assert.deepEqual(objects, retainedObjects);
    console.log(
      "PASS interrupted independent publication resumes the same verified bundle and preserves existing objects",
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
      () => {
        return { succeeded: true };
      },
      (error) => {
        return { succeeded: false, error };
      },
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
      /registry HEAD changed before archive registration/,
    );
    await verify(concurrent, newer);
    console.log(
      "PASS stale concurrent publisher cannot overwrite the completed publication",
    );
  } finally {
    await concurrent.sql.end();
  }

  const aba = await fixture(initial);
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
    const outcome = run(["publish", "--output-dir", next.output], aba.env).then(
      () => {
        return { succeeded: true };
      },
      (error) => {
        return { succeeded: false, error };
      },
    );
    let restored;
    try {
      await Promise.race([
        firstObserved,
        outcome.then((result) => {
          if (!result.succeeded) throw result.error;
          throw new Error("First publisher did not reach the object boundary");
        }),
      ]);
      await run(["publish", "--output-dir", newer.output], aba.env);
      await run(["publish", "--output-dir", initial.output], aba.env);
      restored = await heads(aba.sql);
    } finally {
      releaseFirst();
      await outcome;
    }
    const result = await outcome;
    assert.equal(result.succeeded, false);
    assert.match(
      result.error.stderr,
      /registry HEAD changed before archive registration/,
    );
    assert.deepEqual(await heads(aba.sql), restored);
    await verify(aba, initial);
    console.log(
      "PASS xmin rejects a stale publisher even after HEAD content returns to its original digest",
    );
  } finally {
    await aba.sql.end();
  }
} finally {
  interceptPut = undefined;
  await new Promise((resolve) => {
    return server.close(resolve);
  });
  await Promise.all(requests);
  for (const schema of schemas)
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
  for (const role of roles) await admin`DROP ROLE ${admin(role)}`;
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
