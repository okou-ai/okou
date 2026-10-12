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
    "Actual Runner-state contraction preserves canonical data and safely replays",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
