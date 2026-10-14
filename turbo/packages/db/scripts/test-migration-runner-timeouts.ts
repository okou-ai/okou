#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { Client, DatabaseError, Query } from "pg";
import {
  applyPendingMigrations,
  NON_TRANSACTIONAL_MIGRATION_MARKER,
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
    await assert.rejects(
      applyPendingMigrations(sql),
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
