import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { runnerState } from "../src/runtime/runner-state";
import { runnerStatePreparedHome } from "./fixtures/runner-state-prepared-home-affinity";
import { applyPendingMigrations } from "./migration-runner";
import { validatePermanentRunnerStateStorage } from "./test-runner-state-storage-permanent";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `runner_contraction_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_retire_workspace_runner_state");
});
assert.ok(
  contraction,
  "Retain the contraction validator through the physical deployment gate",
);
await admin.query(`CREATE DATABASE "${databaseName}"`);
const client = new Client({ connectionString: url.toString() });
const migrationSql = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  await client.connect();
  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when,
  });
  const db = drizzle(client);
  const runnerId = randomUUID();
  const observation = {
    runnerId,
    runnerGroup: "vm0/contraction",
    heartbeatGeneration: 17,
    heartbeatSequence: 43,
    totalVcpu: 12,
    totalMemoryMb: 24_576,
    maxConcurrent: 6,
    allocatedVcpu: 4,
    allocatedMemoryMb: 8192,
    runningCount: 2,
    admittableProfiles: ["vm0/default", "vm0/large"],
    heldHomeStates: [
      {
        reuseKey: "thread:canonical",
        lastCompletedAt: "2026-10-12T01:00:00Z",
        homeCaches: [
          { profile: "vm0/default", homeAffinityVersion: 1 as const },
        ],
      },
    ],
    heldSandboxStates: [
      {
        reuseKey: "thread:canonical",
        lastCompletedAt: "2026-10-12T01:00:00Z",
        reusableSandbox: {
          profile: "vm0/default",
          historyGenerationRunId: randomUUID(),
        },
      },
    ],
    activeReuseProducers: [
      {
        runId: randomUUID(),
        reuseKey: "thread:canonical",
        profile: "vm0/default",
      },
    ],
    wssIngressServiceActive: true,
    lastSeenAt: new Date("2026-10-12T01:01:00Z"),
  } satisfies typeof runnerState.$inferInsert;
  await db.insert(runnerStatePreparedHome).values([
    {
      ...observation,
      heldWorkspaceStates: [
        {
          reuseKey: "thread:discarded-workspace",
          lastCompletedAt: "2026-10-11T00:00:00Z",
          workspaceCaches: [
            { profile: "vm0/default", workspaceAffinityVersion: 1 },
          ],
        },
      ],
      homeAffinityVersion: 1,
      homeAffinityGeneration: 17,
      homeAffinitySequence: 43,
    },
    {
      runnerId: randomUUID(),
      runnerGroup: "vm0/empty-contraction",
      lastSeenAt: observation.lastSeenAt,
    },
  ]);
  const before = await db
    .select()
    .from(runnerState)
    .orderBy(runnerState.runnerId);
  const columnsBefore = (
    await client.query(
      "SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid = 'public.runner_state'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attname",
    )
  ).rows;
  const journalBefore = (
    await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")
  ).rows;

  for (const dependency of [
    {
      create:
        "CREATE INDEX runner_state_unexpected_index ON runner_state (home_affinity_version)",
      drop: "DROP INDEX runner_state_unexpected_index",
    },
    {
      create:
        "ALTER TABLE runner_state ADD CONSTRAINT runner_state_unexpected_check CHECK (home_affinity_generation >= 0)",
      drop: "ALTER TABLE runner_state DROP CONSTRAINT runner_state_unexpected_check",
    },
    {
      create:
        "CREATE VIEW runner_state_unexpected_view AS SELECT held_workspace_states FROM runner_state",
      drop: "DROP VIEW runner_state_unexpected_view",
    },
    {
      create:
        "CREATE FUNCTION runner_state_unexpected_routine() RETURNS bigint LANGUAGE sql AS $$ SELECT home_affinity_sequence FROM runner_state LIMIT 1 $$",
      drop: "DROP FUNCTION runner_state_unexpected_routine()",
    },
    {
      create:
        "CREATE TABLE runner_state_unexpected_child () INHERITS (runner_state)",
      drop: "DROP TABLE runner_state_unexpected_child",
    },
  ]) {
    await client.query(dependency.create);
    await assert.rejects(
      applyPendingMigrations(migrationSql, {
        beforeMillis: contraction.when + 1,
      }),
      (error: unknown) => {
        return (
          error instanceof Error &&
          "code" in error &&
          error.code === "2BP01" &&
          error.message.includes(
            "Unexpected Runner state retirement dependencies",
          )
        );
      },
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      ).rows,
      journalBefore,
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid = 'public.runner_state'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attname",
        )
      ).rows,
      columnsBefore,
    );
    assert.deepEqual(
      await db.select().from(runnerState).orderBy(runnerState.runnerId),
      before,
    );
    await client.query(dependency.drop);
  }
  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual(
    await db.select().from(runnerState).orderBy(runnerState.runnerId),
    before,
  );
  assert.deepEqual(
    z
      .array(z.object({ attname: z.string() }))
      .parse(
        (
          await client.query(
            "SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid = 'public.runner_state'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attname",
          )
        ).rows,
      )
      .map((column) => {
        return column.attname;
      }),
    Object.values(getTableColumns(runnerState))
      .map((column) => {
        return column.name;
      })
      .sort(),
  );
  const appliedJournal = (
    await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")
  ).rows;
  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual(
    (
      await client.query(
        "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
      )
    ).rows,
    appliedJournal,
  );
  assert.deepEqual(
    await db
      .select()
      .from(runnerState)
      .where(eq(runnerState.runnerId, runnerId)),
    before.filter((row) => {
      return row.runnerId === runnerId;
    }),
  );
  await validatePermanentRunnerStateStorage(url.toString());
  console.log(
    "Actual Runner-state contraction preserves canonical data and journal atomicity, rejects unexpected dependencies, and safely replays",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
