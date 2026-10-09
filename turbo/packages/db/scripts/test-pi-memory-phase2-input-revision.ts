import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { applyPendingMigrations } from "./migration-runner";
import { piMemoryPhase2Jobs as outgoingJobs } from "./fixtures/checkpoint-retirement-outgoing";
import { storages } from "../src/schema/storage";
import { piMemoryPhase2InputRevisionSql } from "../../../apps/api/src/signals/services/pi-memory-phase2-input-revision";
import { parseRawRows } from "../../../apps/api/src/lib/db-raw-rows";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `memory_revision_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
const ownedUrl = new URL(databaseUrl);
ownedUrl.pathname = `/${databaseName}`;
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: ownedUrl.toString() });
await client.connect();
const db = drizzle(client);
const now = new Date();
const returnedStorageSchema = z.object({ memoryStorageId: z.uuid() });

function owner(memoryStorageId: string) {
  return {
    memoryStorageId,
    orgId: "revision-org",
    userId: `revision-${memoryStorageId}`,
    enqueuedAt: now,
  };
}

async function seedStorage() {
  const id = randomUUID();
  await db.insert(storages).values({
    id,
    orgId: "revision-org",
    userId: `revision-${id}`,
    name: "memory",
    s3Prefix: id,
  });
  return id;
}

async function advance(memoryStorageId: string) {
  const rows = parseRawRows(
    returnedStorageSchema,
    await db.execute(piMemoryPhase2InputRevisionSql(owner(memoryStorageId))),
  );
  assert.deepEqual(rows, [{ memoryStorageId }]);
}

async function state(memoryStorageId: string) {
  const [row] = await db
    .select({
      status: outgoingJobs.status,
      inputRevision: outgoingJobs.inputRevision,
      claimedRevision: outgoingJobs.claimedRevision,
      leaseToken: outgoingJobs.leaseToken,
      sandboxLeaseToken: outgoingJobs.sandboxLeaseToken,
      claimedSelectionDigest: outgoingJobs.claimedSelectionDigest,
      retryCount: outgoingJobs.retryCount,
      retryAt: outgoingJobs.retryAt,
      lastErrorClass: outgoingJobs.lastErrorClass,
      updatedAt: outgoingJobs.updatedAt,
    })
    .from(outgoingJobs)
    .where(eq(outgoingJobs.memoryStorageId, memoryStorageId));
  assert.ok(row);
  return row;
}

try {
  await applyPendingMigrations(migrationSql);
  const retained = await seedStorage();
  const fresh = await seedStorage();
  await db.insert(outgoingJobs).values(owner(retained));
  await advance(retained);
  assert.equal((await state(retained)).inputRevision, 2);

  // The actual outgoing ORM emits DEFAULT for its obsolete mapped column.
  // This demonstrates the preparation release is necessary before contraction.
  await client.query(
    "ALTER TABLE pi_memory_phase2_jobs DROP COLUMN last_maintenance_checkpoint_id",
  );
  await assert.rejects(
    db.insert(outgoingJobs).values(owner(fresh)),
    (error: unknown) => {
      return (
        error instanceof Error &&
        typeof error.cause === "object" &&
        error.cause !== null &&
        "code" in error.cause &&
        error.cause.code === "42703"
      );
    },
  );
  await advance(fresh);
  assert.equal((await state(fresh)).inputRevision, 1);
  await advance(retained);
  assert.equal((await state(retained)).inputRevision, 3);

  const leaseToken = randomUUID();
  await db
    .update(outgoingJobs)
    .set({
      status: "leased",
      claimedRevision: 3,
      claimedBaseVersionId: "a".repeat(64),
      leaseToken,
      sandboxLeaseToken: leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 3_600_000),
      claimedSelectionDigest: "b".repeat(64),
      claimedSelectedCount: 0,
      claimedSelectedUtf8Bytes: 0,
    })
    .where(eq(outgoingJobs.memoryStorageId, retained));
  await advance(retained);
  const leased = await state(retained);
  assert.equal(leased.status, "leased");
  assert.equal(leased.inputRevision, 4);
  assert.equal(leased.claimedRevision, 3);
  assert.equal(leased.leaseToken, leaseToken);
  assert.equal(leased.sandboxLeaseToken, leaseToken);
  assert.equal(leased.claimedSelectionDigest, "b".repeat(64));
  assert.equal(leased.updatedAt.getTime(), now.getTime());

  await db
    .update(outgoingJobs)
    .set({
      status: "retryable_failure",
      retryCount: 1,
      retryAt: now,
      lastErrorClass: "provider_error",
    })
    .where(eq(outgoingJobs.memoryStorageId, fresh));
  await advance(fresh);
  const retried = await state(fresh);
  assert.equal(retried.status, "pending");
  assert.equal(retried.inputRevision, 2);
  assert.equal(retried.retryCount, 0);
  assert.equal(retried.retryAt, null);
  assert.equal(retried.lastErrorClass, null);
  console.log(
    "Phase 2 revision writes survive column contraction, preserve active claims, and reset unleased retry state.",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
