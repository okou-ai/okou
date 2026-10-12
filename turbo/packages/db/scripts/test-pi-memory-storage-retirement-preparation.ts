import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { schema } from "../src/index";
import { piMemoryPhase2Jobs } from "../src/runtime/pi-memory-phase2-job";
import { piMemoryPhase2Jobs as retainedJobs } from "../src/schema/pi-memory-phase2-job";
import { storages } from "../src/schema/storage";

function hasSqlState(error: unknown, code: string) {
  return (
    error instanceof Error &&
    error.cause instanceof Error &&
    "code" in error.cause &&
    error.cause.code === code
  );
}

/** Retain until physical contraction is deployed and accepted under #39171. */
export async function validatePiMemoryStorageRetirementPreparation(
  databaseUrl: string,
) {
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
    await client.query(
      `CREATE TABLE "${namespace}".pi_memory_phase2_checkpoints (LIKE public.pi_memory_phase2_checkpoints INCLUDING ALL)`,
    );
    await client.query(`SET search_path TO "${namespace}", public`);

    for (const phase of ["retained", "contracted"] as const) {
      if (phase === "contracted") {
        await client.query(
          `DROP TABLE "${namespace}".pi_memory_phase2_checkpoints RESTRICT`,
        );
        await client.query(
          `ALTER TABLE "${namespace}".pi_memory_phase2_jobs DROP COLUMN legacy_lease_token RESTRICT, DROP COLUMN sandbox_lease_token RESTRICT, DROP COLUMN last_maintenance_checkpoint_version_id RESTRICT`,
        );
      }

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
        const predicate = eq(
          piMemoryPhase2Jobs.memoryStorageId,
          memoryStorageId,
        );
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
        if (phase === "retained") {
          // The outgoing prepared field list remains writable after migration.
          await db
            .update(retainedJobs)
            .set({
              ...claim,
              sandboxLeaseToken: leaseToken,
              legacyLeaseToken: null,
            })
            .where(eq(retainedJobs.memoryStorageId, memoryStorageId));
        }
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

        if (phase === "retained") {
          // Outgoing completion writers can still populate compatibility output.
          await db
            .update(retainedJobs)
            .set({
              lastMaintenancePublicationVersionId:
                outcome === "failed" ? null : "d".repeat(64),
            })
            .where(eq(retainedJobs.memoryStorageId, memoryStorageId));
          const [compatibility] = await db
            .select({
              sandboxLeaseToken: retainedJobs.sandboxLeaseToken,
              versionId: retainedJobs.lastMaintenancePublicationVersionId,
            })
            .from(retainedJobs)
            .where(eq(retainedJobs.memoryStorageId, memoryStorageId));
          assert.ok(compatibility);
          assert.equal(compatibility.sandboxLeaseToken, leaseToken);
          assert.equal(
            compatibility.versionId,
            outcome === "failed" ? null : "d".repeat(64),
          );
        }
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
      if (phase === "contracted") {
        await assert.rejects(
          db.select().from(retainedJobs),
          (error: unknown) => {
            return hasSqlState(error, "42703");
          },
        );
      }
    }
    console.log(
      "Pi memory canonical Job SQL, root queries and guards survive compatibility storage contraction.",
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
