import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { runnerState } from "../src/schema/runner-state";
import { outgoingRunnerState } from "./fixtures/runner-state-before-hostname";
import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(
  databaseUrl,
  "DATABASE_URL is required (disposable local PostgreSQL only)",
);
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const name = `runner_hostname_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${name}"`);
const url = new URL(databaseUrl);
url.pathname = `/${name}`;
const migrationClient = postgres(url.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: url.toString() });
try {
  const journal = z
    .object({
      entries: z.array(z.object({ tag: z.string(), when: z.number() })),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../src/migrations/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const migration = journal.entries.find((entry) => {
    return entry.tag.endsWith("_runner_hostname");
  });
  assert.ok(migration, "hostname expansion must be in the journal");
  await applyPendingMigrations(migrationClient, {
    beforeMillis: migration.when,
  });
  await client.connect();
  const db = drizzle(client);
  const row = {
    runnerId: randomUUID(),
    runnerGroup: "vm0/production",
    heartbeatGeneration: 7,
    heartbeatSequence: 1,
    totalVcpu: 8,
    totalMemoryMb: 16384,
    maxConcurrent: 2,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
    runningCount: 0,
    admittableProfiles: ["vm0/default"],
    heldSandboxStates: [],
    heldHomeStates: [],
    activeReuseProducers: [],
    mode: "running",
    wssIngressServiceActive: false,
    lastSeenAt: new Date("2026-10-20T00:00:00Z"),
  };
  const [before] = await db.insert(outgoingRunnerState).values(row).returning();
  await applyPendingMigrations(migrationClient);
  assert.deepEqual(
    await db
      .select()
      .from(outgoingRunnerState)
      .where(eq(outgoingRunnerState.runnerId, row.runnerId)),
    [before],
  );
  const [expanded] = await db
    .select()
    .from(runnerState)
    .where(eq(runnerState.runnerId, row.runnerId));
  assert.deepEqual(expanded, { ...before, runnerHostname: null });

  // Outgoing complete INSERT/RETURNING remains valid after expansion.
  const secondId = randomUUID();
  const [second] = await db
    .insert(outgoingRunnerState)
    .values({ ...row, runnerId: secondId })
    .returning();
  assert.deepEqual(second, { ...before, runnerId: secondId });
  await db
    .update(runnerState)
    .set({ runnerHostname: "prod-11.example.test" })
    .where(eq(runnerState.runnerId, row.runnerId));
  const oldUpdate = { ...row, heartbeatSequence: 2 };
  await db
    .insert(outgoingRunnerState)
    .values(oldUpdate)
    .onConflictDoUpdate({
      target: outgoingRunnerState.runnerId,
      set: oldUpdate,
      setWhere: or(
        lt(
          outgoingRunnerState.heartbeatGeneration,
          oldUpdate.heartbeatGeneration,
        ),
        and(
          eq(
            outgoingRunnerState.heartbeatGeneration,
            oldUpdate.heartbeatGeneration,
          ),
          lt(
            outgoingRunnerState.heartbeatSequence,
            oldUpdate.heartbeatSequence,
          ),
        ),
      ),
    })
    .returning();
  const [retained] = await db
    .select()
    .from(runnerState)
    .where(eq(runnerState.runnerId, row.runnerId));
  assert.equal(retained?.heartbeatSequence, 2);
  assert.equal(retained?.runnerHostname, "prod-11.example.test");
  // This retained value is why hostname selection remains inactive until the
  // parent's complete-writer drain/refresh and rollback gates are verified.
  console.log(
    "Runner hostname expansion preserves outgoing ORM operations; partial writers can retain locality while advancing order",
  );
} finally {
  await client.end();
  await migrationClient.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
}
