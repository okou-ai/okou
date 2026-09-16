import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { storageVersions, storages } from "@okouai/db/schema/storage";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import { db } from "../lib/db";
import { now } from "../lib/time";
import { captureDeferredStorage } from "./pi-deferred-storage";

/** An actual private maintenance lease and its callback binding. */
export async function captureDeferredMaintenance(f: {
  runId: string;
  sessionId: string;
  userId: string;
  orgId: string;
}) {
  const mount = await captureDeferredStorage(f);
  const selected: readonly [] = [];
  const maintenance = {
    schemaVersion: 1 as const,
    memoryStorageId: mount.storageId,
    claimedRevision: 1,
    claimedBaseVersionId: mount.version,
    leaseToken: randomUUID(),
    selectionDigest: piMemoryPhase2SelectionDigest(selected),
    selected,
  };
  await db()
    .insert(piMemoryPhase2Jobs)
    .values({
      memoryStorageId: mount.storageId,
      orgId: f.orgId,
      userId: f.userId,
      status: "leased",
      inputRevision: 1,
      claimedRevision: 1,
      claimedBaseVersionId: mount.version,
      leaseToken: maintenance.leaseToken,
      sandboxLeaseToken: maintenance.leaseToken,
      leaseExpiresAt: new Date(now() + 120_000),
      maintenanceRunId: f.runId,
      claimedSelectionDigest: maintenance.selectionDigest,
      claimedSelectedCount: 0,
      claimedSelectedUtf8Bytes: 0,
    });
  await db()
    .insert(agentRunCallbacks)
    .values({
      runId: f.runId,
      internalKind: "pi-memory:phase2",
      payload: { ...maintenance, orgId: f.orgId, userId: f.userId },
    });
  await db()
    .update(agentRuns)
    .set({ chatThreadId: null })
    .where(eq(agentRuns.id, f.runId));
  await db()
    .update(agentSessions)
    .set({ agentId: null })
    .where(eq(agentSessions.id, f.sessionId));
  onTestFinished(async () => {
    await db()
      .delete(piMemoryPhase2Jobs)
      .where(eq(piMemoryPhase2Jobs.memoryStorageId, mount.storageId));
  });
  return maintenance;
}

/** A valid changed-output checkpoint for the captured maintenance claim. */
export async function captureDeferredMaintenanceCheckpoint(
  f: {
    runId: string;
    userId: string;
    orgId: string;
  },
  maintenance: {
    memoryStorageId: string;
    claimedBaseVersionId: string;
  },
) {
  const versionId = createHash("sha256")
    .update(`${f.runId}:maintenance-checkpoint`)
    .digest("hex");
  return await db().transaction(async (tx) => {
    await tx.insert(storageVersions).values({
      id: versionId,
      storageId: maintenance.memoryStorageId,
      s3Key: `${f.orgId}/${maintenance.memoryStorageId}/${versionId}`,
      size: 16,
      archiveSize: 8,
      fileCount: 1,
      createdBy: f.userId,
    });
    await tx
      .update(storages)
      .set({ headVersionId: versionId })
      .where(eq(storages.id, maintenance.memoryStorageId));
    await tx.insert(storageVersionLineage).values({
      storageId: maintenance.memoryStorageId,
      versionId,
      parentVersionId: maintenance.claimedBaseVersionId,
      runId: f.runId,
    });
    const [conversation] = await tx
      .insert(conversations)
      .values({
        runId: f.runId,
        cliAgentType: "pi",
        cliAgentSessionId: f.runId,
      })
      .onConflictDoUpdate({
        target: conversations.runId,
        set: { cliAgentType: "pi", cliAgentSessionId: f.runId },
      })
      .returning({ id: conversations.id });
    if (!conversation) {
      throw new Error("Missing deferred maintenance conversation");
    }
    const [checkpoint] = await tx
      .insert(checkpoints)
      .values({
        runId: f.runId,
        conversationId: conversation.id,
        storageMounts: [
          {
            orgId: f.orgId,
            userId: f.userId,
            name: "memory",
            storageId: maintenance.memoryStorageId,
            version: versionId,
            mountPath: PI_MEMORY_ROOT,
            writeback: true,
            missingRootPolicy: "fail",
          },
        ],
      })
      .returning({ id: checkpoints.id });
    if (!checkpoint) {
      throw new Error("Missing deferred maintenance checkpoint");
    }
    return { id: checkpoint.id, versionId };
  });
}
