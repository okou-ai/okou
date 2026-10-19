#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import postgres from "postgres";
import { Client, DatabaseError, Query } from "pg";
import {
  applyPendingMigrations,
  NON_TRANSACTIONAL_MIGRATION_MARKER,
  UUID_BATCH_MIGRATION_MARKER,
} from "./migration-runner";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}
const DATABASE_URL = process.env.DATABASE_URL;

const testDatabase = `migration_runner_timeouts_${process.pid}_${Date.now()}`;
const fixtureDirectory = await fs.mkdtemp(
  path.join(tmpdir(), "okou-migration-runner-"),
);

async function createTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${testDatabase}"`);
  } finally {
    await client.end();
  }
}

async function dropTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${testDatabase}"`);
  } finally {
    await client.end();
  }
}

async function writeMigrationFixture(): Promise<void> {
  const migrationsDirectory = path.join(fixtureDirectory, "src", "migrations");
  await fs.mkdir(path.join(migrationsDirectory, "meta"), { recursive: true });
  await fs.writeFile(
    path.join(migrationsDirectory, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: 1,
          tag: "0000_transactional_timeouts",
          breakpoints: true,
        },
        {
          idx: 1,
          version: "7",
          when: 2,
          tag: "0001_non_transactional_timeouts",
          breakpoints: true,
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(migrationsDirectory, "0000_transactional_timeouts.sql"),
    `DO $$
BEGIN
  IF current_setting('lock_timeout')::interval <> interval '1 second' THEN
    RAISE EXCEPTION 'expected lock_timeout 1s, got %', current_setting('lock_timeout');
  END IF;
  IF current_setting('statement_timeout')::interval <> interval '10 seconds' THEN
    RAISE EXCEPTION 'expected statement_timeout 10s, got %', current_setting('statement_timeout');
  END IF;
END
$$;
--> statement-breakpoint
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('lock_timeout')::interval <> interval '3 seconds' THEN
    RAISE EXCEPTION 'expected overridden lock_timeout 3s, got %', current_setting('lock_timeout');
  END IF;
  IF current_setting('statement_timeout')::interval <> interval '30 seconds' THEN
    RAISE EXCEPTION 'expected overridden statement_timeout 30s, got %', current_setting('statement_timeout');
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE migration_probe (id integer PRIMARY KEY, value integer NOT NULL);
--> statement-breakpoint
INSERT INTO migration_probe (id, value) VALUES (1, 0);
`,
  );
  await fs.writeFile(
    path.join(migrationsDirectory, "0001_non_transactional_timeouts.sql"),
    `${NON_TRANSACTIONAL_MIGRATION_MARKER}
DO $$
BEGIN
  IF current_setting('lock_timeout')::interval <> interval '7 seconds' THEN
    RAISE EXCEPTION 'expected session lock_timeout 7s, got %', current_setting('lock_timeout');
  END IF;
  IF current_setting('statement_timeout')::interval <> interval '70 seconds' THEN
    RAISE EXCEPTION 'expected session statement_timeout 70s, got %', current_setting('statement_timeout');
  END IF;
END
$$;
`,
  );
}

async function appendMigrationFixture(
  idx: number,
  tag: string,
  migration: string,
): Promise<void> {
  const directory = path.join(fixtureDirectory, "src", "migrations");
  const journalPath = path.join(directory, "meta", "_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as {
    entries: {
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }[];
  };
  await fs.writeFile(path.join(directory, `${tag}.sql`), migration);
  journal.entries.push({
    idx,
    version: "7",
    when: idx + 1,
    tag,
    breakpoints: true,
  });
  await fs.writeFile(journalPath, JSON.stringify(journal));
}

async function validateMigrationRunnerTimeouts(): Promise<void> {
  const testDatabaseUrl = new URL(DATABASE_URL);
  testDatabaseUrl.pathname = `/${testDatabase}`;
  testDatabaseUrl.searchParams.set(
    "options",
    "-c lock_timeout=7s -c statement_timeout=70s",
  );

  async function expectCliFailure(
    expected: {
      file: string;
      phase: string;
      statement: number | null;
      batch: number | null;
      sqlstate: string;
    },
    message: RegExp,
  ): Promise<void> {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("migrate.ts", import.meta.url)),
      ],
      {
        cwd: fixtureDirectory,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl.toString() },
      },
    );
    child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 1, stderr);
    assert.match(stderr, message);
    const records = stderr
      .split("\n")
      .filter((line) => {
        return line.startsWith('{"event":');
      })
      .map((line) => {
        return z
          .object({
            event: z.string(),
            file: z.string(),
            phase: z.string().optional(),
            statement: z.number().nullable().optional(),
            statementCount: z.number().optional(),
            batch: z.number().nullable().optional(),
            elapsedMs: z.number().optional(),
            sqlstate: z.string().nullable().optional(),
          })
          .parse(JSON.parse(line));
      });
    const failures = records.filter((record) => {
      return record.event === "migration_failed";
    });
    assert.equal(failures.length, 1, stderr);
    const failure = failures[0];
    assert.ok(failure);
    assert.deepEqual(
      {
        file: failure.file,
        phase: failure.phase,
        statement: failure.statement,
        batch: failure.batch,
        sqlstate: failure.sqlstate,
      },
      expected,
      stderr,
    );
    assert.ok(failure.elapsedMs !== undefined && failure.elapsedMs >= 0);
    assert.ok(
      records.some((record) => {
        return (
          record.event === "migration_started" && record.file === expected.file
        );
      }),
    );
    assert.ok(
      !records.some((record) => {
        return (
          record.event === "migration_completed" &&
          record.file === expected.file
        );
      }),
    );
  }

  const originalDirectory = process.cwd();
  const sql = postgres(testDatabaseUrl.toString(), { max: 1 });
  process.chdir(fixtureDirectory);
  try {
    await applyPendingMigrations(sql);
    const ledger = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM "drizzle"."__drizzle_migrations"
    `;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.count, 2);

    // Journal failure is an infrastructure state, with no product API entry.
    // Keep this runner contract independent of any shipped migration tag.
    await appendMigrationFixture(
      2,
      "0002_journal_atomicity",
      `ALTER TABLE migration_probe ADD COLUMN annotation text;
--> statement-breakpoint
UPDATE migration_probe SET value = 1, annotation = 'applied';`,
    );
    await sql.unsafe(`
      CREATE FUNCTION reject_probe_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected journal failure'; END $$;
      CREATE TRIGGER reject_probe_journal BEFORE INSERT ON drizzle.__drizzle_migrations
        FOR EACH ROW WHEN (NEW.created_at = 3) EXECUTE FUNCTION reject_probe_journal();
    `);
    const state = async () => {
      return Array.from(
        await sql`
        SELECT to_jsonb(p) AS row,
          (SELECT count(*)::integer FROM drizzle.__drizzle_migrations) AS journal
        FROM migration_probe p
      `,
      );
    };
    const before = await state();
    await expectCliFailure(
      {
        file: "0002_journal_atomicity.sql",
        phase: "journal",
        statement: null,
        batch: null,
        sqlstate: "P0001",
      },
      /injected journal failure/,
    );
    assert.deepEqual(await state(), before);
    await sql.unsafe(
      "DROP TRIGGER reject_probe_journal ON drizzle.__drizzle_migrations",
    );
    await applyPendingMigrations(sql);
    assert.deepEqual(await state(), [
      { row: { id: 1, value: 1, annotation: "applied" }, journal: 3 },
    ]);
    const committed = await state();
    await applyPendingMigrations(sql);
    assert.deepEqual(await state(), committed);

    await appendMigrationFixture(
      3,
      "0003_lock_retry",
      "UPDATE migration_probe SET value = 2;",
    );
    const blocker = new Client({
      connectionString: testDatabaseUrl.toString(),
    });
    await blocker.connect();
    try {
      const backend = await blocker.query<{ pid: unknown }>(
        "SELECT pg_backend_pid() AS pid",
      );
      assert.equal(backend.rowCount, 1);
      const pid = backend.rows[0]?.pid;
      assert.ok(
        typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0,
      );

      class PausedCopy extends Query<Record<string, unknown>, []> {
        paused = false;

        handleCopyData(message: { chunk: unknown }): void {
          if (!this.paused) {
            this.paused = true;
            blocker.connection.stream.pause();
            this.emit("firstCopyData", message.chunk);
          }
        }
      }

      // COPY emits during execution; a modifying-CTE SELECT portal can finish
      // its UPDATE before returning the first row. Bound output to about 64 MiB.
      const resource = new PausedCopy(`COPY (
        WITH held AS (
          UPDATE migration_probe SET value = 3 WHERE id = 1 RETURNING id, value
        )
        SELECT id, value, ordinal, repeat('x', 8192)
        FROM held CROSS JOIN generate_series(1, 8192) AS ordinal
      ) TO STDOUT`);
      let resourceEnded = false;
      const outcome = new Promise<unknown>((resolve) => {
        resource.once("error", (error: unknown) => {
          resourceEnded = true;
          resolve(error);
        });
        resource.once("end", () => {
          resourceEnded = true;
          resolve(new Error("COPY completed before cancellation"));
        });
      });
      const firstData = new Promise<unknown>((resolve) => {
        resource.once("firstCopyData", resolve);
      });
      // Own early failure before submission so it cannot become readiness.
      const ready = Promise.race([
        firstData,
        outcome.then((error) => {
          throw error;
        }),
      ]);
      try {
        blocker.query(resource);
        const first = await ready;
        assert.ok(Buffer.isBuffer(first));
        assert.equal(first.toString("utf8"), `1\t3\t1\t${"x".repeat(8192)}\n`);
        assert.equal(blocker.connection.stream.isPaused(), true);
        assert.equal(resourceEnded, false);
        await assert.rejects(applyPendingMigrations(sql), /lock timeout/);
        assert.deepEqual(await state(), committed);
      } finally {
        let cancellationRequested = false;
        try {
          if (!resourceEnded) {
            const cancelled = await sql`
              SELECT pg_cancel_backend(${pid}) AS cancelled
            `;
            assert.deepEqual(Array.from(cancelled), [{ cancelled: true }]);
            cancellationRequested = true;
          }
        } finally {
          blocker.connection.stream.resume();
          const error = await outcome;
          // This query waits for the target's ReadyForQuery, including after
          // an early native error. Its own idle ACK proves rollback and release.
          const releaseACK = await blocker.query(
            "SELECT id, value, annotation FROM migration_probe",
          );
          assert.equal(releaseACK.rowCount, 1);
          assert.deepEqual(releaseACK.rows, [
            { id: 1, value: 1, annotation: "applied" },
          ]);
          assert.equal(blocker.getTransactionStatus(), "I");
          if (cancellationRequested) {
            assert.ok(error instanceof DatabaseError);
            assert.equal(error.code, "57014");
          }
        }
      }
    } finally {
      await blocker.end();
    }
    assert.deepEqual(await state(), committed);
    await applyPendingMigrations(sql);
    assert.deepEqual(await state(), [
      { row: { id: 1, value: 2, annotation: "applied" }, journal: 4 },
    ]);

    await appendMigrationFixture(
      4,
      "0004_uuid_batches",
      `CREATE TABLE batch_probe (id uuid PRIMARY KEY, eligible boolean NOT NULL, value integer NOT NULL);
INSERT INTO batch_probe
SELECT ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  i BETWEEN 3 AND 5, 0 FROM generate_series(1, 6) i;
--> statement-breakpoint
${UUID_BATCH_MIGRATION_MARKER}
WITH batch AS MATERIALIZED (
  SELECT id FROM batch_probe WHERE $1::uuid IS NULL OR id > $1::uuid
  ORDER BY id LIMIT 2
), updated AS (
  UPDATE batch_probe p SET value = 10 FROM batch b
  WHERE p.id = b.id AND p.eligible RETURNING p.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;`,
    );
    await applyPendingMigrations(sql);
    assert.deepEqual(
      Array.from(await sql`SELECT value FROM batch_probe ORDER BY id`),
      [0, 0, 10, 10, 10, 0].map((value) => {
        return { value };
      }),
    );

    const failureTag = "0005_uuid_batch_rollback";
    const batchBody = `${UUID_BATCH_MIGRATION_MARKER}
WITH batch AS MATERIALIZED (
  SELECT id FROM batch_probe WHERE $1::uuid IS NULL OR id > $1::uuid
  ORDER BY id LIMIT 2
), updated AS (
  UPDATE batch_probe p SET value = p.value + 1 / CASE
    WHEN p.id = '00000000-0000-0000-0000-000000000005'::uuid THEN 0 ELSE 1 END
  FROM batch b WHERE p.id = b.id RETURNING p.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;`;
    await appendMigrationFixture(
      5,
      failureTag,
      `ALTER TABLE batch_probe ADD COLUMN annotation text;
--> statement-breakpoint
${batchBody}`,
    );
    const beforeBatches = Array.from(
      await sql`SELECT * FROM batch_probe ORDER BY id`,
    );
    await expectCliFailure(
      {
        file: `${failureTag}.sql`,
        phase: "execute",
        statement: 2,
        batch: 3,
        sqlstate: "22012",
      },
      /division by zero/,
    );
    assert.deepEqual(
      Array.from(await sql`SELECT * FROM batch_probe ORDER BY id`),
      beforeBatches,
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
      )[0]?.count,
      5,
    );
    await fs.writeFile(
      path.join(fixtureDirectory, "src", "migrations", `${failureTag}.sql`),
      batchBody.replace("THEN 0 ELSE 1", "THEN 1 ELSE 1"),
    );
    await applyPendingMigrations(sql);
    const afterBatches = Array.from(
      await sql`SELECT value FROM batch_probe ORDER BY id`,
    );
    assert.deepEqual(
      afterBatches,
      [1, 1, 11, 11, 11, 1].map((value) => {
        return { value };
      }),
    );
    await applyPendingMigrations(sql);
    assert.deepEqual(
      Array.from(await sql`SELECT value FROM batch_probe ORDER BY id`),
      afterBatches,
    );

    await appendMigrationFixture(
      6,
      "0006_stuck_batch_cursor",
      `${UUID_BATCH_MIGRATION_MARKER}
WITH batch AS MATERIALIZED (
  SELECT COALESCE($1::uuid, '00000000-0000-0000-0000-000000000001'::uuid) AS id LIMIT 1
)
SELECT (SELECT id FROM batch) AS next_cursor;`,
    );
    await assert.rejects(
      applyPendingMigrations(sql),
      /Batch cursor did not advance/,
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
      )[0]?.count,
      6,
    );
    await fs.writeFile(
      path.join(fixtureDirectory, "src/migrations/0006_stuck_batch_cursor.sql"),
      `${UUID_BATCH_MIGRATION_MARKER}
WITH batch AS MATERIALIZED (SELECT NULLIF($1::uuid, $1::uuid) AS id LIMIT 1)
SELECT (SELECT id FROM batch) AS next_cursor;`,
    );
    await applyPendingMigrations(sql);

    await appendMigrationFixture(
      7,
      "0007_statement_timeout",
      `
CREATE TABLE timeout_probe (id integer);
--> statement-breakpoint

--> statement-breakpoint
SET LOCAL statement_timeout = '20ms';
--> statement-breakpoint
SELECT pg_sleep(1);`,
    );
    await expectCliFailure(
      {
        file: "0007_statement_timeout.sql",
        phase: "execute",
        statement: 4,
        batch: null,
        sqlstate: "57014",
      },
      /statement timeout/,
    );
    assert.equal(
      (await sql`SELECT to_regclass('timeout_probe') AS relation`)[0]?.relation,
      null,
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
      )[0]?.count,
      7,
    );
    await fs.writeFile(
      path.join(fixtureDirectory, "src/migrations/0007_statement_timeout.sql"),
      "SELECT 1;",
    );
    await applyPendingMigrations(sql);

    await appendMigrationFixture(
      8,
      "0008_non_transactional_failure",
      `${NON_TRANSACTIONAL_MIGRATION_MARKER}
CREATE TABLE partial_probe (id integer);
--> statement-breakpoint
SELECT 1 / 0;`,
    );
    await expectCliFailure(
      {
        file: "0008_non_transactional_failure.sql",
        phase: "execute",
        statement: 2,
        batch: null,
        sqlstate: "22012",
      },
      /division by zero/,
    );
    assert.equal(
      (await sql`SELECT to_regclass('partial_probe')::text AS relation`)[0]
        ?.relation,
      "partial_probe",
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
      )[0]?.count,
      8,
    );
    await fs.writeFile(
      path.join(
        fixtureDirectory,
        "src/migrations/0008_non_transactional_failure.sql",
      ),
      `${NON_TRANSACTIONAL_MIGRATION_MARKER}\nSELECT 1;`,
    );
    await applyPendingMigrations(sql);

    await appendMigrationFixture(
      9,
      "0009_non_transactional_uuid_batches",
      `${NON_TRANSACTIONAL_MIGRATION_MARKER}
${UUID_BATCH_MIGRATION_MARKER}
WITH batch AS MATERIALIZED (
  SELECT id FROM autocommit_probe
  WHERE ($1::uuid IS NULL OR id > $1::uuid) AND NOT processed
  ORDER BY id LIMIT 2
), updated AS (
  UPDATE autocommit_probe p
  SET processed = true, value = value + 1 / CASE WHEN reject THEN 0 ELSE 1 END
  FROM batch b WHERE p.id = b.id AND NOT p.processed RETURNING p.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;`,
    );
    await sql.unsafe(`
      CREATE TABLE autocommit_probe (
        id uuid PRIMARY KEY, processed boolean NOT NULL DEFAULT false,
        value integer NOT NULL DEFAULT 0, reject boolean NOT NULL
      );
      INSERT INTO autocommit_probe (id, reject)
      SELECT ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, i = 5
      FROM generate_series(1, 6) i;
    `);
    await expectCliFailure(
      {
        file: "0009_non_transactional_uuid_batches.sql",
        phase: "execute",
        statement: 1,
        batch: 3,
        sqlstate: "22012",
      },
      /division by zero/,
    );
    assert.deepEqual(
      Array.from(await sql`SELECT value FROM autocommit_probe ORDER BY id`),
      [1, 1, 1, 1, 0, 0].map((value) => {
        return { value };
      }),
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
      )[0]?.count,
      9,
    );
    // A second full attempt must not reapply any committed batch.
    await assert.rejects(applyPendingMigrations(sql), /division by zero/);
    assert.deepEqual(
      Array.from(await sql`SELECT value FROM autocommit_probe ORDER BY id`),
      [1, 1, 1, 1, 0, 0].map((value) => {
        return { value };
      }),
    );
    await sql`UPDATE autocommit_probe SET reject = false`;
    await applyPendingMigrations(sql);
    assert.deepEqual(
      Array.from(await sql`SELECT value FROM autocommit_probe ORDER BY id`),
      [1, 1, 1, 1, 1, 1].map((value) => {
        return { value };
      }),
    );
    await applyPendingMigrations(sql);
    assert.deepEqual(
      Array.from(await sql`SELECT value FROM autocommit_probe ORDER BY id`),
      [1, 1, 1, 1, 1, 1].map((value) => {
        return { value };
      }),
    );

    await appendMigrationFixture(
      10,
      "0010_commit_failure",
      `
CREATE TABLE deferred_parent (id integer PRIMARY KEY);
CREATE TABLE deferred_child (id integer REFERENCES deferred_parent DEFERRABLE INITIALLY DEFERRED);
INSERT INTO deferred_child VALUES (1);`,
    );
    await expectCliFailure(
      {
        file: "0010_commit_failure.sql",
        phase: "commit",
        statement: null,
        batch: null,
        sqlstate: "23503",
      },
      /violates foreign key constraint/,
    );
    assert.equal(
      (await sql`SELECT to_regclass('deferred_child') AS relation`)[0]
        ?.relation,
      null,
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
      )[0]?.count,
      10,
    );
    await fs.writeFile(
      path.join(fixtureDirectory, "src/migrations/0010_commit_failure.sql"),
      "SELECT 1;",
    );
    await applyPendingMigrations(sql);
    await sql.unsafe(`
      CREATE TABLE bounded_probe (
        id uuid PRIMARY KEY, processed boolean NOT NULL DEFAULT false,
        value integer NOT NULL DEFAULT 0, reject boolean NOT NULL,
        note text
      );
      INSERT INTO bounded_probe (id, reject)
      SELECT ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, i = 101
      FROM generate_series(1, 250) i;
    `);
    await appendMigrationFixture(
      11,
      "0011_bounded_uuid_batches",
      `${NON_TRANSACTIONAL_MIGRATION_MARKER}
${UUID_BATCH_MIGRATION_MARKER}
-- UTF-8 prefix π: comments and the literal 'LIMIT 1000' are not batch bounds.
WITH batch AS MATERIALIZED (
  SELECT id FROM bounded_probe
  WHERE ($1::uuid IS NULL OR id > $1::uuid) AND NOT processed
  ORDER BY id LIMIT 1000
), updated AS (
  UPDATE bounded_probe p SET processed = true,
    value = value + 1 / CASE WHEN reject THEN 0 ELSE 1 END,
    note = 'LIMIT 1000'
  FROM batch b WHERE p.id = b.id AND NOT p.processed RETURNING p.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;`,
    );
    await expectCliFailure(
      {
        file: "0011_bounded_uuid_batches.sql",
        phase: "execute",
        statement: 1,
        batch: 2,
        sqlstate: "22012",
      },
      /division by zero/,
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM bounded_probe WHERE processed`
      )[0]?.count,
      100,
    );
    await sql`UPDATE bounded_probe SET reject = false`;
    await applyPendingMigrations(sql);
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM bounded_probe WHERE processed AND value = 1 AND note = 'LIMIT 1000'`
      )[0]?.count,
      250,
    );
    await applyPendingMigrations(sql);
    assert.equal(
      (await sql`SELECT sum(value)::int AS total FROM bounded_probe`)[0]?.total,
      250,
    );
  } finally {
    process.chdir(originalDirectory);
    await sql.end();
  }
}

try {
  await writeMigrationFixture();
  await createTestDatabase();
  try {
    await validateMigrationRunnerTimeouts();
  } finally {
    await dropTestDatabase();
  }
} finally {
  await fs.rm(fixtureDirectory, { recursive: true, force: true });
}

console.log(
  "Migration runner timeouts, atomic journal rollback and retries validated",
);
