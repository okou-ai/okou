import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { array, boolean, number, object, string } from "zod";

/** Verify pending and already-applied 1524 converge without rewriting history. */
export async function validateConnectorSkillBundleDdlReplay(
  databaseUrl: string,
) {
  const database = `connector_ddl_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${database}`;
  const admin = new Client({ connectionString: databaseUrl });
  const client = new Client({ connectionString: testUrl.href });
  const root = fileURLToPath(new URL("../src/migrations/", import.meta.url));
  const journal = object({
    entries: array(
      object({
        idx: number(),
        version: string(),
        when: number(),
        tag: string(),
        breakpoints: boolean(),
      }),
    ),
  }).parse(
    JSON.parse(
      await fs.readFile(path.join(root, "meta/_journal.json"), "utf8"),
    ),
  );
  const prepare = journal.entries.find((e) => {
    return e.tag === "1524_connector_skill_bundle_preparation";
  });
  const validate = journal.entries.find((e) => {
    return e.tag === "1525_validate_connector_skill_bundles";
  });
  assert(prepare && validate);
  const original = await fs.readFile(
    path.join(root, `${prepare.tag}.sql`),
    "utf8",
  );
  const validation = await fs.readFile(
    path.join(root, `${validate.tag}.sql`),
    "utf8",
  );
  const directory = await fs.mkdtemp(
    path.join(tmpdir(), "connector-bundle-ddl-"),
  );
  const migrations = path.join(directory, "src/migrations");
  let created = false;

  async function writeJournal(includeValidation: boolean) {
    await fs.writeFile(
      path.join(migrations, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: includeValidation ? [prepare, validate] : [prepare],
      }),
    );
  }

  async function migrate() {
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            fileURLToPath(new URL("./migrate.ts", import.meta.url)),
          ],
          {
            cwd: directory,
            env: { ...process.env, DATABASE_URL: testUrl.href },
            stdio: ["ignore", "ignore", "pipe"],
            timeout: 30_000,
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (data: string) => {
          stderr += data;
        });
        child.once("error", reject);
        child.once("close", (code) => {
          resolve({ code, stderr });
        });
      },
    );
    assert.equal(result.code, 0, result.stderr);
  }

  async function assertConstraints(validated: boolean) {
    const result =
      await client.query(`SELECT conname, convalidated FROM pg_constraint
      WHERE conname IN ('connector_catalog_entries_skill_content_bundle_check',
        'org_custom_connectors_skill_content_bundle_check') ORDER BY conname`);
    assert.deepEqual(result.rows, [
      {
        conname: "connector_catalog_entries_skill_content_bundle_check",
        convalidated: validated,
      },
      {
        conname: "org_custom_connectors_skill_content_bundle_check",
        convalidated: validated,
      },
    ]);
  }

  try {
    await fs.mkdir(path.join(migrations, "meta"), { recursive: true });
    await fs.writeFile(path.join(migrations, `${prepare.tag}.sql`), original);
    await fs.writeFile(
      path.join(migrations, `${validate.tag}.sql`),
      validation,
    );
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await client.connect();
    const source = "a".repeat(64);
    const bundle = { sha256: "b".repeat(64), archiveBytes: 100 };

    // Frozen outgoing columns: both tables already have data before expansion.
    await client.query(`CREATE TABLE connector_catalog_entries (hash text PRIMARY KEY, skill jsonb NOT NULL);
      CREATE TABLE org_custom_connectors (id integer PRIMARY KEY, skill_storage_version_id text)`);
    await client.query(
      "INSERT INTO connector_catalog_entries VALUES ('catalog', $1)",
      [{ kind: "bundled", versionId: source, archiveSize: 100 }],
    );
    await client.query("INSERT INTO org_custom_connectors VALUES (1, $1)", [
      source,
    ]);
    await writeJournal(false);
    await migrate();
    await assertConstraints(false);
    const before = await client.query(
      "SELECT to_jsonb(c) AS row FROM connector_catalog_entries c",
    );
    assert.deepEqual(before.rows, [
      {
        row: {
          hash: "catalog",
          skill: {
            kind: "bundled",
            versionId: source,
            archiveSize: 100,
          },
          skill_content_bundle: null,
          skill_content_bundle_source_version_id: null,
        },
      },
    ]);

    const update = `UPDATE connector_catalog_entries SET skill_content_bundle=$1,
      skill_content_bundle_source_version_id=$2 WHERE hash='catalog'`;
    await client.query(update, [bundle, source]);
    await assert.rejects(
      client.query(update, [{ ...bundle, archiveBytes: 101 }, source]),
      { code: "23514" },
    );
    await client.query(
      `UPDATE org_custom_connectors SET skill_content_bundle=$1,
      skill_content_bundle_source_version_id=$2 WHERE id=1`,
      [bundle, source],
    );
    await assert.rejects(
      client.query(
        `UPDATE org_custom_connectors SET skill_content_bundle=NULL WHERE id=1`,
      ),
      { code: "23514" },
    );
    // An outgoing writer remains legal while preparation and validation are separate commits.
    await client.query(
      "UPDATE org_custom_connectors SET skill_storage_version_id=$1 WHERE id=1",
      ["c".repeat(64)],
    );
    await migrate();
    await assertConstraints(false);
    await writeJournal(true);
    await migrate();
    await assertConstraints(true);
    const saved = await client.query(
      "SELECT skill_content_bundle, skill_content_bundle_source_version_id FROM connector_catalog_entries",
    );
    assert.deepEqual(saved.rows, [
      {
        skill_content_bundle: bundle,
        skill_content_bundle_source_version_id: source,
      },
    ]);
    const hashes = await client.query(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
    );
    assert.deepEqual(hashes.rows, [
      {
        hash: createHash("sha256").update(original).digest("hex"),
        created_at: String(prepare.when),
      },
      {
        hash: createHash("sha256").update(validation).digest("hex"),
        created_at: String(validate.when),
      },
    ]);
    await migrate();
    await assertConstraints(true);

    // A database that already applied the immutable original needs only 1525.
    await client.query(
      "DROP TABLE connector_catalog_entries, org_custom_connectors",
    );
    await client.query("TRUNCATE drizzle.__drizzle_migrations");
    await client.query(`CREATE TABLE connector_catalog_entries (hash text PRIMARY KEY, skill jsonb NOT NULL);
      CREATE TABLE org_custom_connectors (id integer PRIMARY KEY, skill_storage_version_id text)`);
    for (const statement of original.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)",
      [createHash("sha256").update(original).digest("hex"), prepare.when],
    );
    await migrate();
    await assertConstraints(true);
  } finally {
    await client.end();
    try {
      if (created) await admin.query(`DROP DATABASE "${database}"`);
    } finally {
      await admin.end();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  console.log(
    "Connector Skill preparation enforcement, original journal identity, validation and retries passed",
  );
}
