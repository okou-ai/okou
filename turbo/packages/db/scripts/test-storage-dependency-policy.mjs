import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { test } from "node:test";

const checker = fileURLToPath(
  new URL("../../../scripts/check-storage-dependencies.mjs", import.meta.url),
);
const checkerPath = "turbo/scripts/check-storage-dependencies.mjs";
const baselinePath = "turbo/storage-dependency-baseline.json";
const owner = "turbo/apps/api/src/signals/services/legacy.service.ts";
const consumer = "turbo/apps/api/src/existing.ts";
const feature = "turbo/apps/api/src/new-feature.ts";
const ownerCode = [
  'import { storages } from "@okouai/db/schema/storage";',
  "export function load() { return storages; }",
].join("\n");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "storage-policy-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete env[name];
  function run(command, args) {
    return spawnSync(command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  }
  function git(...args) {
    const result = run("git", [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Storage policy fixture",
      "-c",
      "user.email=storage-policy@example.invalid",
      ...args,
    ]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(file, code) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, code);
  }
  function commit() {
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture state");
    return git("rev-parse", "HEAD");
  }
  function inventory() {
    const result = run(process.execPath, [checker, "--inventory"]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  function check(base, passed, message) {
    const result = run(process.execPath, [checker, base]);
    assert.equal(result.status === 0, passed, result.stdout + result.stderr);
    if (message) assert.match(result.stderr, message);
  }
  git("init", "--quiet", "--initial-branch=main");
  write(
    "turbo/packages/db/src/schema/storage.ts",
    "export const storages = {};",
  );
  write(
    "turbo/packages/db/src/runtime/system-storage-presigned-url-cache.ts",
    "export const systemStoragePresignedUrlCache = {};",
  );
  write(owner, ownerCode);
  write(
    consumer,
    'import { load } from "./signals/services/legacy.service"; load();',
  );
  const base = commit();
  write(baselinePath, JSON.stringify(inventory()));
  return {
    root,
    base,
    git,
    write,
    commit,
    inventory,
    check,
    activate() {
      write(checkerPath, readFileSync(checker, "utf8"));
      return commit();
    },
  };
}

test("initial inventory permits existing dependencies, unrelated object storage and lexical shadowing", (t) => {
  const f = fixture(t);
  f.write(
    feature,
    [
      'import { S3Client } from "@aws-sdk/client-s3";',
      'import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";',
      'const key = "registry-archives/v1/digest.tar.gz";',
      'globalThis.localStorage.setItem("key", key);',
      "const statement = \"SELECT 'FROM storages' AS sample FROM registry_resource_archives\";",
      'const sharedCache = "SELECT cache_key FROM system_storage_presigned_url_cache";',
      'const protocolModule = ["webhooks", "storages"];',
      'const browserCache = { storages: [] }; browserCache.storages.push("local");',
      "export { S3Client, statement, sharedCache, protocolModule, systemStoragePresignedUrlCache };",
    ].join("\n"),
  );
  f.write(
    owner,
    ownerCode + "\nfunction unrelated(storages) { return storages; }",
  );
  const before = readFileSync(join(f.root, baselinePath), "utf8");
  f.check(f.base, true);
  assert.equal(readFileSync(join(f.root, baselinePath), "utf8"), before);
});

test("an existing import cannot grow, even with a regenerated candidate baseline", (t) => {
  const f = fixture(t);
  const base = f.activate();
  f.write(
    owner,
    ownerCode + "\nexport function newBusiness() { return storages; }",
  );
  f.check(base, false, /grew from 2 to 3/);
  f.write(baselinePath, JSON.stringify(f.inventory()));
  f.check(base, false, /New legacy Storage dependencies are prohibited/);
});

test("new schema and existing Storage-owner consumers are rejected across import forms", (t) => {
  const f = fixture(t);
  const base = f.activate();
  for (const source of [
    '// eslint-disable\nimport { storages as data } from "@okouai/db/schema/storage"; data;',
    'import { storages } from "../../../packages/db/src/schema/storage.ts"; storages;',
    'import { storages } from "@okouai/db/schema/storage.js"; storages;',
    'import * as old from "./signals/services/legacy.service"; old.load();',
    'export { load } from "./signals/services/legacy.service";',
    'export * from "./signals/services/legacy.service";',
    'const old = require("./signals/services/legacy.service"); old.load();',
    'const old = await import("./signals/services/legacy.service"); old.load();',
    "const old = await import(`./signals/services/legacy.service`); old.load();",
    "const old = require(`./signals/services/legacy.service`); old.load();",
    'import old = require("@okouai/db/schema/storage"); old.storages;',
    'type Old = import("@okouai/db/schema/storage").Storage;',
  ]) {
    f.write(feature, source);
    f.check(base, false, /New legacy Storage dependencies are prohibited/);
  }
});

test("literal SQL and schema-object access cannot bypass the import boundary", (t) => {
  const f = fixture(t);
  const base = f.activate();
  for (const source of [
    'const q = "SELECT id FROM public.storages";',
    "const q = " +
      JSON.stringify(
        'UPDATE /* note */ "public"."storage_versions" SET id = \'x\'',
      ) +
      ";",
    'const q = "SELECT id FROM storage_publication_tokens";',
    'const old = pgTable("storages", {});',
    'import { pgTable as define } from "drizzle-orm/pg-core"; const old = define("storage_versions", {});',
    'db.query["storages"].findMany();',
    "db.query.storageVersions.findMany();",
    'import { schema as tables } from "@okouai/db"; tables.storages.id;',
    "const { storageVersions: versions } = db.query; versions.findMany();",
  ]) {
    f.write(feature, source);
    f.check(base, false, /New legacy Storage dependencies are prohibited/);
  }
});

test("migration removes stale entries and a reduced main baseline cannot be resurrected", (t) => {
  const f = fixture(t);
  const base = f.activate();
  rmSync(join(f.root, owner));
  rmSync(join(f.root, consumer));
  f.git("add", "-u");
  f.check(base, false, /remove the unused baseline/);
  f.write(baselinePath, JSON.stringify(f.inventory()));
  f.check(base, true);
  const reduced = f.commit();
  f.write(owner, ownerCode);
  f.write(
    consumer,
    'import { load } from "./signals/services/legacy.service"; load();',
  );
  f.write(baselinePath, JSON.stringify(f.inventory()));
  f.check(reduced, false, /grew from 0/);
});

test("initial registration cannot admit same-PR dependencies, and activated bootstrap stays closed", (t) => {
  const f = fixture(t);
  f.write(
    feature,
    'import { storages } from "@okouai/db/schema/storage"; storages;',
  );
  f.write(baselinePath, JSON.stringify(f.inventory()));
  f.check(f.base, false, /New legacy Storage dependencies are prohibited/);
  rmSync(join(f.root, feature));
  f.write(baselinePath, JSON.stringify(f.inventory()));
  f.write(checkerPath, readFileSync(checker, "utf8"));
  rmSync(join(f.root, baselinePath));
  const invalidBase = f.commit();
  f.write(baselinePath, JSON.stringify(f.inventory()));
  f.check(invalidBase, false, /bootstrap is closed/);
});
