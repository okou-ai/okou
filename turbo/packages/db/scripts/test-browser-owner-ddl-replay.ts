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
const breakpoint = "--> statement-breakpoint";

/** The real migration CLI must recover every committed Browser DDL prefix. */
export async function validateBrowserOwnerDdlReplay(databaseUrl: string) {
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
  const original = journal.entries.find((entry) => {
    return entry.tag === "1462_browser_owner_windows";
  });
  const normalization = journal.entries.find((entry) => {
    return entry.tag.endsWith("_browser_owner_atomic_constraints");
  });
  assert(original && normalization);
  const originalWhen = original.when;
  const normalizationWhen = normalization.when;
  const originalSql = await fs.readFile(
    path.join(packageDirectory, `src/migrations/${original.tag}.sql`),
    "utf8",
  );
  const normalizationSql = await fs.readFile(
    path.join(packageDirectory, `src/migrations/${normalization.tag}.sql`),
    "utf8",
  );
  const replaySql = await fs.readFile(
    new URL(
      "./migration-replays/1462_browser_owner_windows.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const directory = await fs.mkdtemp(path.join(tmpdir(), "browser-owner-ddl-"));
  const database = `browser_ddl_${randomUUID().replaceAll("-", "")}`;
  const role = `browser_ddl_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${database}`;
  const admin = new Client({ connectionString: databaseUrl });
  const client = new Client({ connectionString: testUrl.href });
  let databaseCreated = false;
  let roleCreated = false;
  let referenceSchema: unknown;

  // This replay precedes the chat-table cutover. Compare its historical DDL
  // across committed prefixes; final-schema invariants run independently.
  async function verifyHistoricalSchema() {
    const relations = await client.query(`SELECT relname FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND relname IN ('browser_owner_profiles', 'browser_owner_windows')
      ORDER BY relname`);
    assert.deepEqual(relations.rows, [
      { relname: "browser_owner_profiles" },
      { relname: "browser_owner_windows" },
    ]);
    const schema = await client.query(`
      SELECT 'constraint' AS kind, c.relname AS owner, k.conname AS name,
        pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname IN ('browser_owner_profiles', 'browser_owner_windows')
      UNION ALL
      SELECT 'index', tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('browser_owner_profiles', 'browser_owner_windows')
      ORDER BY kind, owner, name`);
    if (referenceSchema === undefined) {
      referenceSchema = schema.rows;
    } else {
      assert.deepEqual(schema.rows, referenceSchema);
    }
  }

  async function migrate(url = testUrl.href, success = true) {
    const result = await new Promise<{
      code: number | null;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), migrationCli],
        {
          cwd: directory,
          env: { ...process.env, DATABASE_URL: url },
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
    });
    if (success) assert.equal(result.code, 0, result.stderr);
    else {
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /permission denied for table __drizzle_migrations/u,
      );
    }
  }

  async function reset() {
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  }

  async function createJournal() {
    await client.query('CREATE SCHEMA "drizzle"');
    await client.query(`CREATE TABLE "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`);
  }

  async function verify() {
    const result = await client.query(
      'SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at',
    );
    assert.deepEqual(result.rows, [
      {
        hash: createHash("sha256").update(originalSql).digest("hex"),
        created_at: String(originalWhen),
      },
      {
        hash: createHash("sha256").update(normalizationSql).digest("hex"),
        created_at: String(normalizationWhen),
      },
    ]);
    await verifyHistoricalSchema();
  }

  try {
    const migrations = path.join(directory, "src/migrations");
    await fs.mkdir(path.join(migrations, "meta"), { recursive: true });
    await fs.writeFile(
      path.join(migrations, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [original, normalization],
      }),
    );
    await fs.writeFile(
      path.join(migrations, `${original.tag}.sql`),
      originalSql,
    );
    await fs.writeFile(
      path.join(migrations, `${normalization.tag}.sql`),
      normalizationSql,
    );
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    await client.connect();

    const replayStatements = replaySql.split(breakpoint);
    for (let prefix = 0; prefix <= replayStatements.length; prefix++) {
      await reset();
      for (const statement of replayStatements.slice(0, prefix)) {
        await client.query(statement);
      }
      await migrate();
      await verify();
    }

    // A native permission failure rejects the journal, after all DDL commits.
    await reset();
    await createJournal();
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}'`);
    roleCreated = true;
    await admin.query(`GRANT CREATE ON DATABASE "${database}" TO "${role}"`);
    await client.query(
      `GRANT USAGE, CREATE ON SCHEMA public, drizzle TO "${role}"`,
    );
    await client.query(
      `GRANT SELECT ON drizzle.__drizzle_migrations TO "${role}"`,
    );
    const writerUrl = new URL(testUrl);
    writerUrl.username = role;
    writerUrl.password = rolePassword;
    await migrate(writerUrl.href, false);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
        )
      ).rows[0].count,
      0,
    );
    await verifyHistoricalSchema();
    await client.query(
      `GRANT INSERT ON drizzle.__drizzle_migrations TO "${role}"`,
    );
    await client.query(
      `GRANT USAGE ON SEQUENCE drizzle.__drizzle_migrations_id_seq TO "${role}"`,
    );
    await migrate(writerUrl.href);
    await verify();

    const normalizationStatements = normalizationSql.split(breakpoint);
    for (let prefix = 0; prefix <= normalizationStatements.length; prefix++) {
      await reset();
      for (const statement of originalSql.split(breakpoint)) {
        await client.query(statement);
      }
      await createJournal();
      await client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [createHash("sha256").update(originalSql).digest("hex"), original.when],
      );
      const profileId = randomUUID();
      const instanceId = randomUUID();
      const chatId = randomUUID();
      await client.query(
        `INSERT INTO browser_owner_profiles
          (id, org_id, user_id, provider_profile_id, instance_id, provider_session_id,
           status, creation_expires_at, timeout_at)
         VALUES ($1, $2, $2, $3, $4, $5, 'active', now() + interval '1 minute', now() + interval '2 minutes')`,
        [profileId, randomUUID(), randomUUID(), instanceId, randomUUID()],
      );
      await client.query(
        `INSERT INTO browser_owner_windows (chat_thread_id, instance_id, state, primary_window_id, expires_at)
         VALUES ($1, $2, 'active', 0, now() + interval '1 minute')`,
        [chatId, instanceId],
      );
      const dataQuery = `SELECT to_jsonb(p) AS profile, to_jsonb(w) AS window
        FROM browser_owner_profiles p JOIN browser_owner_windows w USING (instance_id)`;
      const identitiesQuery = `SELECT oid::text, relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND (relname LIKE 'browser_owner_%' OR relname LIKE 'uq_browser_owner_%' OR relname LIKE 'idx_browser_owner_%')
        ORDER BY relname`;
      const beforeRows = (await client.query(dataQuery)).rows;
      const beforeIdentities = (await client.query(identitiesQuery)).rows;
      for (const statement of normalizationStatements.slice(0, prefix)) {
        await client.query(statement);
      }
      await migrate();
      assert.deepEqual((await client.query(dataQuery)).rows, beforeRows);
      assert.deepEqual(
        (await client.query(identitiesQuery)).rows,
        beforeIdentities,
      );
      await verify();
    }
    console.log(
      "   ✅ Browser DDL: fresh/prefix/journal-failure replay and published index/data preservation",
    );
  } finally {
    try {
      await client.end();
    } finally {
      try {
        if (databaseCreated) await admin.query(`DROP DATABASE "${database}"`);
        if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
      } finally {
        try {
          await admin.end();
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
}
