import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  and,
  arrayContains,
  eq,
  getTableColumns,
  gt,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import { runnerState } from "../src/runtime/runner-state";
import { runnerState as physicalRunnerState } from "../src/schema/runner-state";

/** Executing permanent canonical ORM storage contract. */
async function validateCanonicalRunnerStateStorage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client);
  const runnerId = randomUUID();
  const defaultId = randomUUID();
  const ids = [runnerId, defaultId];
  const runnerGroup = `vm0/storage-${randomUUID()}`;
  const keys = Object.keys(getTableColumns(runnerState)).sort();
  const observation = {
    runnerId,
    runnerHostname: "prod-storage.example.test",
    runnerGroup,
    heartbeatGeneration: 9,
    heartbeatSequence: 4,
    totalVcpu: 8,
    totalMemoryMb: 16_384,
    maxConcurrent: 4,
    allocatedVcpu: 2,
    allocatedMemoryMb: 4096,
    runningCount: 1,
    admittableProfiles: ["vm0/default"],
    heldSandboxStates: [
      {
        reuseKey: "thread:storage",
        lastCompletedAt: "2026-10-12T00:59:00.000Z",
        reusableSandbox: {
          profile: "vm0/default",
          sourceRunId: randomUUID(),
        },
      },
    ],
    heldHomeStates: [
      {
        reuseKey: "thread:storage",
        lastCompletedAt: "2026-10-12T00:59:00.000Z",
        homeCaches: [
          {
            profile: "vm0/default",
            homeAffinityVersion: 1 as const,
            sourceRunId: randomUUID(),
          },
        ],
      },
    ],
    activeReuseProducers: [
      {
        runId: randomUUID(),
        reuseKey: "thread:storage",
        profile: "vm0/default",
      },
    ],
    lastSeenAt: new Date("2026-10-12T01:00:00Z"),
  } satisfies typeof runnerState.$inferInsert;
  const order = (generation: number, sequence: number) => {
    return or(
      lt(runnerState.heartbeatGeneration, generation),
      and(
        eq(runnerState.heartbeatGeneration, generation),
        lt(runnerState.heartbeatSequence, sequence),
      ),
    );
  };
  const holders = () => {
    return db
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .where(
        and(
          eq(runnerState.runnerGroup, runnerGroup),
          eq(runnerState.mode, "running"),
          gt(runnerState.lastSeenAt, new Date("2026-10-12T00:59:30Z")),
          arrayContains(
            runnerState.admittableProfiles,
            sql`${JSON.stringify(["vm0/default"])}::jsonb`,
          ),
          arrayContains(
            runnerState.heldHomeStates,
            sql`${JSON.stringify([
              {
                reuseKey: "thread:storage",
                homeCaches: [
                  { profile: "vm0/default", homeAffinityVersion: 1 },
                ],
              },
            ])}::jsonb`,
          ),
        ),
      );
  };
  try {
    const [defaults] = await db
      .insert(runnerState)
      .values({
        runnerId: defaultId,
        runnerGroup,
        lastSeenAt: observation.lastSeenAt,
      })
      .returning();
    assert.ok(defaults);
    assert.deepEqual(Object.keys(defaults).sort(), keys);
    assert.deepEqual(defaults.heldHomeStates, []);
    assert.deepEqual(defaults.heldSandboxStates, []);
    assert.deepEqual(defaults.admittableProfiles, []);
    assert.deepEqual(defaults.activeReuseProducers, []);
    assert.equal(defaults.heartbeatGeneration, 0);
    assert.equal(defaults.heartbeatSequence, 0);
    assert.equal(defaults.runnerHostname, null);
    assert.equal(defaults.mode, "running");
    const [inserted] = await db
      .insert(runnerState)
      .values(observation)
      .returning();
    assert.ok(inserted);
    assert.deepEqual(Object.keys(inserted).sort(), keys);
    assert.deepEqual(inserted.heldHomeStates, observation.heldHomeStates);
    assert.deepEqual(inserted.heldSandboxStates, observation.heldSandboxStates);
    assert.deepEqual(
      inserted.activeReuseProducers,
      observation.activeReuseProducers,
    );
    assert.equal(inserted.totalVcpu, 8);
    assert.equal(inserted.runnerHostname, observation.runnerHostname);
    assert.equal(inserted.allocatedMemoryMb, 4096);
    assert.deepEqual(
      await db
        .select()
        .from(runnerState)
        .where(eq(runnerState.runnerId, runnerId)),
      [inserted],
    );
    assert.deepEqual(
      await db
        .select(getTableColumns(runnerState))
        .from(physicalRunnerState)
        .where(eq(physicalRunnerState.runnerId, runnerId)),
      [inserted],
    );
    assert.deepEqual(await holders(), [{ runnerId }]);
    const empty = {
      ...observation,
      heartbeatSequence: 5,
      heldHomeStates: [],
      runnerHostname: null,
    };
    const [cleared] = await db
      .insert(runnerState)
      .values(empty)
      .onConflictDoUpdate({
        target: runnerState.runnerId,
        set: empty,
        setWhere: order(9, 5),
      })
      .returning();
    assert.ok(cleared);
    assert.deepEqual(Object.keys(cleared).sort(), keys);
    assert.deepEqual(cleared.heldHomeStates, []);
    assert.equal(cleared.heartbeatSequence, 5);
    assert.equal(cleared.runnerHostname, null);
    assert.deepEqual(cleared.heldSandboxStates, observation.heldSandboxStates);
    assert.deepEqual(
      cleared.activeReuseProducers,
      observation.activeReuseProducers,
    );
    assert.deepEqual(await holders(), []);
    const restarted = {
      ...observation,
      heartbeatGeneration: 10,
      heartbeatSequence: 1,
    };
    const [reset] = await db
      .insert(runnerState)
      .values(restarted)
      .onConflictDoUpdate({
        target: runnerState.runnerId,
        set: restarted,
        setWhere: order(10, 1),
      })
      .returning();
    assert.equal(reset?.heartbeatGeneration, 10);
    assert.equal(reset?.heartbeatSequence, 1);
    assert.equal(reset?.runnerHostname, observation.runnerHostname);
    const stale = { ...empty, runnerHostname: "untrusted-stale.example.test" };
    assert.deepEqual(
      await db
        .insert(runnerState)
        .values(stale)
        .onConflictDoUpdate({
          target: runnerState.runnerId,
          set: stale,
          setWhere: order(9, 5),
        })
        .returning(),
      [],
    );
    assert.deepEqual(
      await db
        .select({ hostname: runnerState.runnerHostname })
        .from(runnerState)
        .where(eq(runnerState.runnerId, runnerId)),
      [{ hostname: observation.runnerHostname }],
    );
    assert.deepEqual(reset?.heldHomeStates, observation.heldHomeStates);
    assert.deepEqual(await holders(), [{ runnerId }]);
    const [updated] = await db
      .update(runnerState)
      .set({ allocatedVcpu: 3, runningCount: 2 })
      .where(eq(runnerState.runnerId, runnerId))
      .returning();
    assert.ok(updated);
    assert.deepEqual(Object.keys(updated).sort(), keys);
    assert.equal(updated.allocatedVcpu, 3);
    assert.equal(updated.runningCount, 2);
    assert.deepEqual(updated.heldHomeStates, observation.heldHomeStates);
    assert.deepEqual(updated.heldSandboxStates, observation.heldSandboxStates);
    assert.deepEqual(
      updated.activeReuseProducers,
      observation.activeReuseProducers,
    );
    console.log(
      "Canonical Runner storage preserves inventories, defaults, empty-state replacement, generation reset and capacity through real ORM statements",
    );
  } finally {
    try {
      await db.delete(runnerState).where(inArray(runnerState.runnerId, ids));
    } finally {
      await client.end();
    }
  }
}

/** Permanent physical and runtime contract on replayed and freshly generated schemas. */
export async function validatePermanentRunnerStateStorage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const columns = z
      .array(z.object({ column_name: z.string() }))
      .parse(
        (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runner_state'",
          )
        ).rows,
      )
      .map((column) => {
        return column.column_name;
      })
      .sort();
    assert.deepEqual(
      columns,
      Object.values(getTableColumns(physicalRunnerState))
        .map((column) => {
          return column.name;
        })
        .sort(),
    );
  } finally {
    await client.end();
  }
  await validateCanonicalRunnerStateStorage(databaseUrl);
}
