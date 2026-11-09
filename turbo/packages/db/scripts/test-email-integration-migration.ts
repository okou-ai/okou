import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { array, boolean, number, object, string } from "zod";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const migrationCli = fileURLToPath(new URL("./migrate.ts", import.meta.url));

/** Email preparation defers validation while preserving applied migration history. */
export async function validateEmailIntegrationMigration(databaseUrl: string) {
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
      await fs.readFile(
        path.join(packageDirectory, "src/migrations/meta/_journal.json"),
        "utf8",
      ),
    ),
  );
  const preparation = journal.entries.find((entry) => {
    return entry.tag === "1534_email_integration";
  });
  const validation = journal.entries.find((entry) => {
    return entry.tag === "1536_validate_email_context_type";
  });
  assert(preparation && validation);
  const originalSql = await fs.readFile(
    path.join(packageDirectory, `src/migrations/${preparation.tag}.sql`),
    "utf8",
  );
  const originalHash = createHash("sha256").update(originalSql).digest("hex");
  const directory = await fs.mkdtemp(path.join(tmpdir(), "email-migration-"));
  const migrations = path.join(directory, "src/migrations");
  const database = `email_migration_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${database}`;
  const admin = new Client({ connectionString: databaseUrl });
  const client = new Client({ connectionString: testUrl.href });
  let databaseCreated = false;

  async function writeJournal(includeValidation: boolean) {
    await fs.writeFile(
      path.join(migrations, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: includeValidation ? [preparation, validation] : [preparation],
      }),
    );
  }

  async function migrate() {
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", import.meta.resolve("tsx"), migrationCli],
          {
            cwd: directory,
            env: { ...process.env, DATABASE_URL: testUrl.href },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ code, stderr });
        });
      },
    );
    assert.equal(result.code, 0, result.stderr);
  }

  try {
    await fs.mkdir(path.join(migrations, "meta"), { recursive: true });
    for (const entry of [preparation, validation]) {
      await fs.copyFile(
        path.join(packageDirectory, `src/migrations/${entry.tag}.sql`),
        path.join(migrations, `${entry.tag}.sql`),
      );
    }
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    await client.connect();

    for (const alreadyApplied of [false, true]) {
      await client.query(`
        DROP SCHEMA IF EXISTS drizzle CASCADE;
        DROP SCHEMA public CASCADE;
        CREATE SCHEMA public;
        CREATE TABLE chat_threads (id uuid PRIMARY KEY);
        CREATE TABLE chat_events (
          id integer PRIMARY KEY,
          context_type text NOT NULL,
          CONSTRAINT chat_events_context_type_check CHECK (context_type = 'web')
        );
        INSERT INTO chat_events VALUES (1, 'web');
      `);
      if (alreadyApplied) {
        // Model an environment that committed the original 1534 successfully.
        await client.query(originalSql);
        await client.query(`
          CREATE SCHEMA drizzle;
          CREATE TABLE drizzle.__drizzle_migrations (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
          );
        `);
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ($1, $2)`,
          [originalHash, preparation.when],
        );
      } else {
        await writeJournal(false);
        await migrate();
      }
      const prepared = await client.query(`
        SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'chat_events'::regclass
          AND conname = 'chat_events_context_type_check'
      `);
      assert.deepEqual(prepared.rows, [{ convalidated: alreadyApplied }]);
      await client.query("INSERT INTO chat_events VALUES (2, 'email')");
      await assert.rejects(
        client.query("INSERT INTO chat_events VALUES (4, 'unknown')"),
        { code: "23514" },
      );

      await writeJournal(true);
      await migrate();
      const validated = await client.query(`
        SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'chat_events'::regclass
          AND conname = 'chat_events_context_type_check'
      `);
      assert.deepEqual(validated.rows, [{ convalidated: true }]);
      const history = await client.query(`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations
        ORDER BY created_at
      `);
      assert.equal(history.rows.length, 2);
      assert.deepEqual(history.rows[0], {
        hash: originalHash,
        created_at: String(preparation.when),
      });
      const rows = await client.query("SELECT * FROM chat_events ORDER BY id");
      assert.deepEqual(rows.rows, [
        { id: 1, context_type: "web" },
        { id: 2, context_type: "email" },
      ]);
      await migrate();
      assert.deepEqual(
        (
          await client.query(
            "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
          )
        ).rows,
        history.rows,
      );
    }
    console.log(
      "   ✅ Email migration: pending/applied history, deferred validation, write enforcement and retry",
    );
  } finally {
    await client.end();
    try {
      if (databaseCreated) await admin.query(`DROP DATABASE "${database}"`);
    } finally {
      await admin.end();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
