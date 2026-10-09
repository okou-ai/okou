import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { and, eq, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { runnerState } from "../src/schema/runner-state";
import { runnerStateBeforeHome } from "./fixtures/runner-state-before-home-affinity";
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
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
