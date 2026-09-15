import { now } from "../lib/time";
/** An actual private maintenance lease and its callback binding. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { db } from "../lib/db";
import { captureDeferredStorage } from "./pi-deferred-storage";

export async function captureDeferredMaintenance(f: {
  runId: string;
  sessionId: string;
  userId: string;
  orgId: string;
}) {
  const mount = await captureDeferredStorage(f);
  const maintenance = {
    schemaVersion: 1 as const,
    memoryStorageId: mount.storageId,
    claimedRevision: 1,
    claimedBaseVersionId: mount.version,
    leaseToken: randomUUID(),
    selectionDigest: mount.version,
    selected: [],
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
