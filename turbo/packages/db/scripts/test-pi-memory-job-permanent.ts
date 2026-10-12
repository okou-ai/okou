import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { schema } from "../src/index";
import { piMemoryPhase2Jobs } from "../src/runtime/pi-memory-phase2-job";
import { storages } from "../src/schema/storage";

function hasSqlState(error: unknown, code: string) {
  return (
    error instanceof Error &&
    error.cause instanceof Error &&
    "code" in error.cause &&
    error.cause.code === code
  );
}

export async function validatePermanentPiMemoryJobs(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client, { schema });
  const namespace = `memory_storage_${randomUUID().replaceAll("-", "")}`;
  const storageIds: string[] = [];
  try {
    await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(
      `CREATE TABLE "${namespace}".pi_memory_phase2_jobs (LIKE public.pi_memory_phase2_jobs INCLUDING ALL)`,
    );
    await client.query(
      `ALTER TABLE "${namespace}".pi_memory_phase2_jobs ADD CONSTRAINT storage_owner_fk FOREIGN KEY (memory_storage_id, org_id, user_id) REFERENCES public.storages (id, org_id, user_id) ON DELETE CASCADE`,
    );
    await client.query(`SET search_path TO "${namespace}", public`);

    for (const outcome of ["published", "no_diff", "failed"] as const) {
      const memoryStorageId = randomUUID();
      storageIds.push(memoryStorageId);
      const owner = {
        memoryStorageId,
        orgId: namespace,
        userId: `user-${memoryStorageId}`,
      };
      await db.insert(storages).values({
        id: memoryStorageId,
        orgId: owner.orgId,
        userId: owner.userId,
        name: "memory",
        s3Prefix: memoryStorageId,
      });
      const predicate = eq(piMemoryPhase2Jobs.memoryStorageId, memoryStorageId);
      await assert.rejects(
        db
          .insert(piMemoryPhase2Jobs)
          .values({ ...owner, userId: "wrong-owner" }),
        (error: unknown) => {
          return hasSqlState(error, "23503");
        },
      );
      const [created] = await db
        .insert(piMemoryPhase2Jobs)
        .values(owner)
        .returning();
      assert.ok(created);
      assert.equal(created.status, "pending");
      assert.equal(created.inputRevision, 1);
      const [upserted] = await db
        .insert(piMemoryPhase2Jobs)
        .values(owner)
        .onConflictDoUpdate({
          target: piMemoryPhase2Jobs.memoryStorageId,
          set: { inputRevision: 2 },
        })
        .returning();
      assert.ok(upserted);
      assert.equal(upserted.inputRevision, 2);
      assert.equal(upserted.createdAt.getTime(), created.createdAt.getTime());

      const now = new Date();
      const leaseToken = randomUUID();
      const maintenanceRunId = randomUUID();
      const claim = {
        status: "leased" as const,
        claimedRevision: 2,
        claimedBaseVersionId: "a".repeat(64),
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + 3_600_000),
        claimedSelectionDigest: "b".repeat(64),
        claimedSelectedCount: 0,
        claimedSelectedUtf8Bytes: 0,
      };

      const [leased] = await db
        .update(piMemoryPhase2Jobs)
        .set({ ...claim, maintenanceRunId })
        .where(predicate)
        .returning();
      assert.ok(leased);
      assert.equal(leased.leaseToken, leaseToken);
      assert.equal(leased.maintenanceRunId, maintenanceRunId);
      await assert.rejects(
        db
          .update(piMemoryPhase2Jobs)
          .set({ leaseToken: null })
          .where(predicate),
        (error: unknown) => {
          return hasSqlState(error, "23514");
        },
      );

      const [settled] = await db
        .update(piMemoryPhase2Jobs)
        .set({
          status: outcome === "failed" ? "retryable_failure" : "idle",
          completedRevision: outcome === "failed" ? 0 : 2,
          claimedRevision: null,
          claimedBaseVersionId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          maintenanceRunId: null,
          claimedSelectionDigest: null,
          claimedSelectedCount: null,
          claimedSelectedUtf8Bytes: null,
          retryCount: outcome === "failed" ? 1 : 0,
          retryAt: outcome === "failed" ? now : null,
          lastErrorClass:
            outcome === "failed" ? "maintenance_run_failed" : null,
          lastSucceededAt: outcome === "failed" ? null : now,
          lastMaintenanceRunId: maintenanceRunId,
          lastMaintenanceRevision: 2,
          lastMaintenanceBaseVersionId: claim.claimedBaseVersionId,
          lastMaintenanceSelectionDigest: claim.claimedSelectionDigest,
          lastMaintenanceOutcome: outcome,
          lastPublishedVersionId:
            outcome === "published" ? "c".repeat(64) : null,
          lastPublishedAt: outcome === "published" ? now : null,
        })
        .where(predicate)
        .returning();
      assert.ok(settled);
      assert.equal(settled.lastMaintenanceOutcome, outcome);
      assert.equal(settled.lastMaintenanceRunId, maintenanceRunId);
      const [selected] = await db
        .select()
        .from(piMemoryPhase2Jobs)
        .where(predicate);
      assert.deepEqual(selected, settled);
      assert.deepEqual(
        await db.query.piMemoryPhase2Jobs.findFirst({ where: predicate }),
        settled,
      );

      await assert.rejects(
        db
          .update(piMemoryPhase2Jobs)
          .set({ maintenanceRunId })
          .where(predicate),
        (error: unknown) => {
          return hasSqlState(error, "23514");
        },
      );
      await assert.rejects(
        db
          .update(piMemoryPhase2Jobs)
          .set({ lastMaintenanceOutcome: null })
          .where(predicate),
        (error: unknown) => {
          return hasSqlState(error, "23514");
        },
      );
      if (outcome === "published") {
        await assert.rejects(
          db
            .update(piMemoryPhase2Jobs)
            .set({
              lastPublishedVersionId: null,
              lastPublishedAt: null,
            })
            .where(predicate),
          (error: unknown) => {
            return hasSqlState(error, "23514");
          },
        );
      }
      if (outcome === "no_diff") {
        await assert.rejects(
          db
            .update(piMemoryPhase2Jobs)
            .set({ lastMaintenanceBaseVersionId: null })
            .where(predicate),
          (error: unknown) => {
            return hasSqlState(error, "23514");
          },
        );
      }
      const [deleted] = await db
        .delete(piMemoryPhase2Jobs)
        .where(predicate)
        .returning();
      assert.deepEqual(deleted, settled);
    }
    console.log(
      "Pi memory Job SQL, root queries, ownership, leases and publication results remain valid.",
    );
  } finally {
    try {
      await client.query(`SET search_path TO public`);
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      for (const id of storageIds) {
        await db.delete(storages).where(eq(storages.id, id));
      }
    } finally {
      await client.end();
    }
  }
}
