import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import {
  and,
  arrayContains,
  eq,
  getTableColumns,
  gt,
  lt,
  or,
  sql as sqlExpression,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { runnerState } from "../src/schema/runner-state";
import { runnerStateBeforeHome } from "./fixtures/runner-state-before-home-affinity";
import { runnerState as canonicalRunnerState } from "../src/runtime/runner-state";
import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `home_affinity_${randomUUID().replaceAll("-", "")}`;
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
const entry = journal.entries.find((item) => {
  return item.tag.endsWith("_prepare_home_affinity");
});
assert.ok(
  entry,
  "Keep the home preparation validator through the deployment/drain cycle",
);
const migration = readMigrationFiles({
  migrationsFolder: DRIZZLE_MIGRATE_OUT,
}).find((item) => {
  return item.folderMillis === entry.when;
});
assert.ok(migration);
await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
const db = drizzle(sql);
try {
  await applyPendingMigrations(sql, { beforeMillis: migration.folderMillis });
  const runnerId = randomUUID();
  const outgoing = {
    runnerId,
    runnerGroup: "vm0/migration",
    heartbeatGeneration: 7,
    heartbeatSequence: 42,
    admittableProfiles: ["vm0/default"],
    lastSeenAt: new Date("2026-10-09T00:00:00Z"),
    heldWorkspaceStates: [
      {
        reuseKey: "thread:retained",
        lastCompletedAt: "2026-10-08T00:00:00.000Z",
        workspaceCaches: [
          { profile: "vm0/default", workspaceAffinityVersion: 1 as const },
        ],
      },
    ],
  } satisfies typeof runnerStateBeforeHome.$inferInsert;
  const before = await db
    .insert(runnerStateBeforeHome)
    .values(outgoing)
    .returning();
  assert.equal(before.length, 1);
  await applyPendingMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });

  // Both mappings really generate SELECT and implicit RETURNING column lists.
  const expanded = await db
    .select()
    .from(runnerState)
    .where(eq(runnerState.runnerId, runnerId));
  assert.equal(expanded.length, 1);
  assert.deepEqual(
    expanded[0]?.heldWorkspaceStates,
    outgoing.heldWorkspaceStates,
  );
  assert.deepEqual(expanded[0]?.heldHomeStates, []);
  assert.equal(expanded[0]?.homeAffinityVersion, null);
  assert.equal(expanded[0]?.homeAffinityGeneration, null);
  assert.equal(expanded[0]?.homeAffinitySequence, null);
  assert.deepEqual(await db.select().from(runnerStateBeforeHome), before);

  const oldUpsert = await db
    .insert(runnerStateBeforeHome)
    .values({ ...outgoing, heartbeatSequence: 43 })
    .onConflictDoUpdate({
      target: runnerStateBeforeHome.runnerId,
      set: { heartbeatSequence: 43 },
    })
    .returning();
  assert.equal(oldUpsert[0]?.heartbeatSequence, 43);
  assert.equal(
    Object.keys(oldUpsert[0] ?? {}).length,
    Object.keys(before[0] ?? {}).length,
  );

  const newObservation = {
    ...outgoing,
    heartbeatSequence: 44,
    heldHomeStates: [
      {
        reuseKey: "thread:retained",
        lastCompletedAt: "2026-10-08T00:00:00.000Z",
        homeCaches: [
          { profile: "vm0/default", homeAffinityVersion: 1 as const },
        ],
      },
    ],
    homeAffinityVersion: 1,
    homeAffinityGeneration: 7,
    homeAffinitySequence: 44,
  } satisfies typeof runnerState.$inferInsert;
  const prepared = await db
    .insert(runnerState)
    .values(newObservation)
    .onConflictDoUpdate({
      target: runnerState.runnerId,
      set: newObservation,
      setWhere: or(
        lt(runnerState.heartbeatGeneration, 7),
        and(
          eq(runnerState.heartbeatGeneration, 7),
          lt(runnerState.heartbeatSequence, 44),
        ),
      ),
    })
    .returning();
  assert.equal(prepared[0]?.homeAffinityVersion, 1);
  assert.deepEqual(prepared[0]?.heldHomeStates, newObservation.heldHomeStates);
  const currentEvidence = () => {
    return db
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .where(
        and(
          eq(runnerState.runnerId, runnerId),
          eq(runnerState.homeAffinityVersion, 1),
          eq(
            runnerState.homeAffinityGeneration,
            runnerState.heartbeatGeneration,
          ),
          eq(runnerState.homeAffinitySequence, runnerState.heartbeatSequence),
        ),
      );
  };
  assert.equal((await currentEvidence()).length, 1);

  // A real outgoing mapping advances only columns that its API knows about.
  await db
    .insert(runnerStateBeforeHome)
    .values({ ...outgoing, heartbeatSequence: 45 })
    .onConflictDoUpdate({
      target: runnerStateBeforeHome.runnerId,
      set: { heartbeatSequence: 45 },
    })
    .returning();
  assert.equal((await currentEvidence()).length, 0);
  let rows = await db
    .select()
    .from(runnerState)
    .where(eq(runnerState.runnerId, runnerId));
  assert.equal(rows[0]?.homeAffinitySequence, 44);
  assert.deepEqual(rows[0]?.heldHomeStates, newObservation.heldHomeStates);
  await db
    .update(runnerStateBeforeHome)
    .set({ heartbeatGeneration: 8, heartbeatSequence: 1 })
    .where(eq(runnerStateBeforeHome.runnerId, runnerId))
    .returning();
  assert.equal((await currentEvidence()).length, 0);

  const late = await db
    .insert(runnerState)
    .values(newObservation)
    .onConflictDoUpdate({
      target: runnerState.runnerId,
      set: newObservation,
      setWhere: or(
        lt(runnerState.heartbeatGeneration, 7),
        and(
          eq(runnerState.heartbeatGeneration, 7),
          lt(runnerState.heartbeatSequence, 44),
        ),
      ),
    })
    .returning();
  assert.equal(late.length, 0);
  await db
    .update(runnerState)
    .set({
      homeAffinityVersion: 1,
      homeAffinityGeneration: 8,
      homeAffinitySequence: 1,
      heldHomeStates: [],
    })
    .where(eq(runnerState.runnerId, runnerId))
    .returning();
  assert.equal(
    (await currentEvidence()).length,
    1,
    "Capability is independent of holding images",
  );
  rows = await db
    .select()
    .from(runnerState)
    .where(eq(runnerState.runnerId, runnerId));
  assert.deepEqual(rows[0]?.heldWorkspaceStates, outgoing.heldWorkspaceStates);
  assert.deepEqual(rows[0]?.heldHomeStates, []);
  await applyPendingMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });
  assert.deepEqual(await db.select().from(runnerState), rows);
  console.log(
    "Home expansion preserves outgoing/current ORM SELECT/INSERT/UPSERT/RETURNING, empty defaults, data, independent stamps, generation/sequence fences and capable empty state.",
  );

  // Production SQL independence and eventual physical shape, not deployed floors.
  // The same production mapping executes on retained and absent retirement columns.
  const canonicalColumns = getTableColumns(canonicalRunnerState);
  const canonicalKeys = Object.keys(canonicalColumns).sort();
  const finalPhysicalColumns = Object.values(canonicalColumns)
    .map((column) => {
      return column.name;
    })
    .sort();
  let retainedCanonicalRow:
    typeof canonicalRunnerState.$inferSelect | undefined;
  const canonicalOrder = (generation: number, sequence: number) => {
    return or(
      lt(canonicalRunnerState.heartbeatGeneration, generation),
      and(
        eq(canonicalRunnerState.heartbeatGeneration, generation),
        lt(canonicalRunnerState.heartbeatSequence, sequence),
      ),
    );
  };
  for (const shape of ["retained", "contracted"] as const) {
    if (shape === "contracted") {
      // Explicitly simulated future contraction, confined to this owned DB.
      await sql`ALTER TABLE runner_state
        DROP COLUMN held_workspace_states,
        DROP COLUMN home_affinity_version,
        DROP COLUMN home_affinity_generation,
        DROP COLUMN home_affinity_sequence`;
      assert.ok(retainedCanonicalRow);
      assert.deepEqual(
        await db
          .select()
          .from(canonicalRunnerState)
          .where(
            eq(canonicalRunnerState.runnerId, retainedCanonicalRow.runnerId),
          ),
        [retainedCanonicalRow],
        "Contraction preserves the complete canonical home/sandbox/capacity row",
      );
    }
    const physicalColumns = z
      .array(z.object({ column_name: z.string() }))
      .parse(
        await sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'runner_state'`,
      )
      .map((column) => {
        return column.column_name;
      })
      .sort();
    assert.deepEqual(
      physicalColumns,
      shape === "retained"
        ? Object.values(getTableColumns(runnerState))
            .map((column) => {
              return column.name;
            })
            .sort()
        : finalPhysicalColumns,
    );

    const canonicalObservation = {
      runnerId: randomUUID(),
      runnerGroup: outgoing.runnerGroup,
      heartbeatGeneration: 9,
      heartbeatSequence: 4,
      totalVcpu: 8,
      totalMemoryMb: 16_384,
      maxConcurrent: 4,
      allocatedVcpu: 2,
      allocatedMemoryMb: 4096,
      runningCount: 1,
      admittableProfiles: outgoing.admittableProfiles,
      heldSandboxStates: [
        {
          reuseKey: "thread:retained",
          lastCompletedAt: "2026-10-08T00:00:00.000Z",
          reusableSandbox: { profile: "vm0/default" },
        },
      ],
      heldHomeStates: newObservation.heldHomeStates,
      lastSeenAt: outgoing.lastSeenAt,
    } satisfies typeof canonicalRunnerState.$inferInsert;
    const inserted = await db
      .insert(canonicalRunnerState)
      .values(canonicalObservation)
      .returning();
    assert.equal(inserted.length, 1);
    assert.deepEqual(Object.keys(inserted[0] ?? {}).sort(), canonicalKeys);
    assert.deepEqual(
      inserted[0]?.heldHomeStates,
      newObservation.heldHomeStates,
    );
    assert.deepEqual(
      inserted[0]?.heldSandboxStates,
      canonicalObservation.heldSandboxStates,
    );
    assert.equal(inserted[0]?.totalVcpu, 8);
    assert.equal(inserted[0]?.allocatedMemoryMb, 4096);
    assert.deepEqual(
      await db
        .select()
        .from(canonicalRunnerState)
        .where(
          eq(canonicalRunnerState.runnerId, canonicalObservation.runnerId),
        ),
      inserted,
    );
    const canonicalHomeHolder = () => {
      return db
        .select({ runnerId: canonicalRunnerState.runnerId })
        .from(canonicalRunnerState)
        .where(
          and(
            eq(canonicalRunnerState.runnerId, canonicalObservation.runnerId),
            eq(canonicalRunnerState.runnerGroup, outgoing.runnerGroup),
            eq(canonicalRunnerState.mode, "running"),
            gt(
              canonicalRunnerState.lastSeenAt,
              new Date("2026-10-08T23:59:30Z"),
            ),
            arrayContains(
              canonicalRunnerState.admittableProfiles,
              sqlExpression`${JSON.stringify(["vm0/default"])}::jsonb`,
            ),
            arrayContains(
              canonicalRunnerState.heldHomeStates,
              sqlExpression`${JSON.stringify([
                {
                  reuseKey: "thread:retained",
                  homeCaches: [
                    { profile: "vm0/default", homeAffinityVersion: 1 },
                  ],
                },
              ])}::jsonb`,
            ),
          ),
        );
    };
    assert.equal((await canonicalHomeHolder()).length, 1);
    for (const staleSequence of [3, 4]) {
      const stale = {
        ...canonicalObservation,
        heartbeatSequence: staleSequence,
        heldHomeStates: [],
      };
      assert.deepEqual(
        await db
          .insert(canonicalRunnerState)
          .values(stale)
          .onConflictDoUpdate({
            target: canonicalRunnerState.runnerId,
            set: stale,
            setWhere: canonicalOrder(9, staleSequence),
          })
          .returning(),
        [],
        "Lower sequence/replay cannot clear a newer canonical observation",
      );
    }
    assert.equal((await canonicalHomeHolder()).length, 1);
    const empty = {
      ...canonicalObservation,
      heartbeatSequence: 5,
      heldHomeStates: [],
    };
    const cleared = await db
      .insert(canonicalRunnerState)
      .values(empty)
      .onConflictDoUpdate({
        target: canonicalRunnerState.runnerId,
        set: empty,
        setWhere: canonicalOrder(9, 5),
      })
      .returning();
    assert.deepEqual(cleared[0]?.heldHomeStates, []);
    assert.equal(cleared[0]?.heartbeatSequence, 5);
    assert.deepEqual(Object.keys(cleared[0] ?? {}).sort(), canonicalKeys);
    assert.equal((await canonicalHomeHolder()).length, 0);
    const restarted = {
      ...canonicalObservation,
      heartbeatGeneration: 10,
      heartbeatSequence: 1,
    };
    const reset = await db
      .insert(canonicalRunnerState)
      .values(restarted)
      .onConflictDoUpdate({
        target: canonicalRunnerState.runnerId,
        set: restarted,
        setWhere: canonicalOrder(10, 1),
      })
      .returning();
    assert.equal(reset[0]?.heartbeatGeneration, 10);
    assert.equal(reset[0]?.heartbeatSequence, 1);
    assert.deepEqual(reset[0]?.heldHomeStates, newObservation.heldHomeStates);
    assert.equal((await canonicalHomeHolder()).length, 1);
    const updated = await db
      .update(canonicalRunnerState)
      .set({ allocatedVcpu: 3, runningCount: 2 })
      .where(eq(canonicalRunnerState.runnerId, canonicalObservation.runnerId))
      .returning();
    assert.deepEqual(Object.keys(updated[0] ?? {}).sort(), canonicalKeys);
    assert.equal(updated[0]?.allocatedVcpu, 3);
    assert.equal(updated[0]?.runningCount, 2);
    assert.deepEqual(
      updated[0]?.heldSandboxStates,
      canonicalObservation.heldSandboxStates,
    );
    assert.deepEqual(updated[0]?.heldHomeStates, newObservation.heldHomeStates);
    if (shape === "retained") {
      retainedCanonicalRow = updated[0];
    }
    console.log(
      `Production canonical home inventory works on ${shape} columns: real INSERT/UPSERT/SELECT/UPDATE/implicit RETURNING, empty state, shared heartbeat fencing, generation reset and preserved data.`,
    );
  }
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
