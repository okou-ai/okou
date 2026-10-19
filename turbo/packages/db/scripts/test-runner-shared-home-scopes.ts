import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { runnerState } from "../src/runtime/runner-state";
import { outgoingRunnerState } from "./fixtures/runner-state-before-shared-home";
import { applyPendingMigrations } from "./migration-runner";

// Temporary old-API overlap validator. The migration, fleet and rollback
// retirement evidence is tracked in #41481; permanent storage checks remain.
export async function validateRunnerSharedHomeScopeMigration(
  databaseUrl: string,
) {
  const journal = z
    .object({
      entries: z.array(z.object({ tag: z.string(), when: z.number() })),
    })
    .parse(
      JSON.parse(
        await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
      ),
    );
  const migration = journal.entries.find((entry) => {
    return entry.tag.endsWith("_runner_shared_home_scopes");
  });
  assert.ok(
    migration,
    "Keep this validator until the #41481 rollout gates close",
  );
  const databaseName = `runner_home_scopes_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  const migrations = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const client = new Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await applyPendingMigrations(migrations, { beforeMillis: migration.when });
    const db = drizzle(client);
    const runnerId = randomUUID();
    const before = {
      runnerId,
      runnerGroup: "vm0/scope-migration",
      heartbeatGeneration: 7,
      heartbeatSequence: 42,
      lastSeenAt: new Date("2026-10-19T09:00:00Z"),
      admittableProfiles: ["vm0/default"],
    };
    const [original] = await db
      .insert(outgoingRunnerState)
      .values(before)
      .returning();
    assert.ok(original);
    await applyPendingMigrations(migrations, {
      beforeMillis: migration.when + 1,
    });
    assert.deepEqual(
      await db
        .select()
        .from(outgoingRunnerState)
        .where(eq(outgoingRunnerState.runnerId, runnerId)),
      [original],
    );
    assert.equal(
      (
        await db
          .select()
          .from(runnerState)
          .where(eq(runnerState.runnerId, runnerId))
      )[0]?.homeCacheScopes,
      null,
    );

    const scopes = {
      snapshotGeneration: 7,
      snapshotSequence: 42,
      profiles: { "vm0/default": "a".repeat(64) },
    };
    await db
      .update(runnerState)
      .set({ homeCacheScopes: scopes })
      .where(eq(runnerState.runnerId, runnerId));
    const currentObservations = () => {
      return db
        .select({ runnerId: runnerState.runnerId })
        .from(runnerState)
        .where(
          and(
            eq(runnerState.runnerId, runnerId),
            eq(
              sql`${runnerState.homeCacheScopes}->>'snapshotGeneration'`,
              sql`cast(${runnerState.heartbeatGeneration} as text)`,
            ),
            eq(
              sql`${runnerState.homeCacheScopes}->>'snapshotSequence'`,
              sql`cast(${runnerState.heartbeatSequence} as text)`,
            ),
          ),
        );
    };
    assert.deepEqual(await currentObservations(), [{ runnerId }]);
    // Actual outgoing ORM statements omit the new column even in full INSERT
    // and RETURNING lists; a new heartbeat must invalidate retained evidence.
    for (const order of [
      { heartbeatGeneration: 7, heartbeatSequence: 43 },
      // A restarted process can eventually reach the retained sequence again.
      { heartbeatGeneration: 8, heartbeatSequence: 42 },
    ]) {
      const [outgoing] = await db
        .insert(outgoingRunnerState)
        .values({ ...before, ...order })
        .onConflictDoUpdate({
          target: outgoingRunnerState.runnerId,
          set: order,
        })
        .returning();
      assert.ok(outgoing);
      assert.equal("homeCacheScopes" in outgoing, false);
      const [retained] = await db
        .select()
        .from(runnerState)
        .where(eq(runnerState.runnerId, runnerId));
      assert.deepEqual(retained?.homeCacheScopes, scopes);
      assert.deepEqual(await currentObservations(), []);
    }
    const [newWriter] = await db
      .update(runnerState)
      .set({
        heartbeatGeneration: 8,
        heartbeatSequence: 43,
        homeCacheScopes: {
          ...scopes,
          snapshotGeneration: 8,
          snapshotSequence: 43,
        },
      })
      .where(eq(runnerState.runnerId, runnerId))
      .returning();
    assert.ok(newWriter);
    assert.deepEqual(await currentObservations(), [{ runnerId }]);
    const [oldRead] = await db
      .select()
      .from(outgoingRunnerState)
      .where(eq(outgoingRunnerState.runnerId, runnerId));
    assert.equal(oldRead?.heartbeatSequence, 43);
    const overlapId = randomUUID();
    await db
      .insert(outgoingRunnerState)
      .values({ ...before, runnerId: overlapId })
      .returning();
    assert.equal(
      (
        await db
          .select()
          .from(runnerState)
          .where(eq(runnerState.runnerId, overlapId))
      )[0]?.homeCacheScopes,
      null,
    );
    await applyPendingMigrations(migrations, {
      beforeMillis: migration.when + 1,
    });
    assert.deepEqual(await currentObservations(), [{ runnerId }]);
    console.log(
      "Shared-home migration preserves outgoing ORM shapes and fences scopes after outgoing sequence/generation writes.",
    );
  } finally {
    await client.end();
    await migrations.end();
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}
