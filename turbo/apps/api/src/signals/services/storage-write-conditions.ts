import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryPhase2Checkpoints } from "@okouai/db/schema/pi-memory-phase2-checkpoint";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { SandboxAuth } from "../../types/auth";
import type { piMemoryPhase2MaintenanceCallbackPayloadSchema } from "./pi-memory-phase2-maintenance.service";

type MaintenancePayload = ReturnType<
  typeof piMemoryPhase2MaintenanceCallbackPayloadSchema.parse
>;
export type MaintenanceReceiptBinding = Omit<
  typeof piMemoryPhase2Checkpoints.$inferInsert,
  "versionId" | "createdAt"
>;
export type StorageIdentity = Pick<
  typeof storages.$inferSelect,
  "id" | "orgId" | "userId" | "name"
>;
export function sandboxStorageRunCondition(auth: SandboxAuth) {
  return and(
    eq(agentRuns.id, auth.runId),
    eq(agentRuns.orgId, auth.orgId),
    eq(agentRuns.userId, auth.userId),
  );
}
export function storageIdentityCondition(identity: StorageIdentity) {
  return and(
    eq(storages.id, identity.id),
    eq(storages.orgId, identity.orgId),
    eq(storages.userId, identity.userId),
    eq(storages.name, identity.name),
  );
}
export function storageVersionCondition(storageId: string, versionId: string) {
  return and(
    eq(storageVersions.storageId, storageId),
    eq(storageVersions.id, versionId),
  );
}
export function maintenanceCallbackCondition(runId: string) {
  return and(
    eq(agentRunCallbacks.runId, runId),
    eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
  );
}
export function storageMaintenanceReceiptCondition(
  binding: MaintenanceReceiptBinding,
) {
  return and(
    eq(piMemoryPhase2Checkpoints.runId, binding.runId),
    eq(piMemoryPhase2Checkpoints.memoryStorageId, binding.memoryStorageId),
    eq(piMemoryPhase2Checkpoints.orgId, binding.orgId),
    eq(piMemoryPhase2Checkpoints.userId, binding.userId),
    eq(piMemoryPhase2Checkpoints.leaseToken, binding.leaseToken),
    eq(piMemoryPhase2Checkpoints.claimedRevision, binding.claimedRevision),
    eq(
      piMemoryPhase2Checkpoints.claimedBaseVersionId,
      binding.claimedBaseVersionId,
    ),
    eq(piMemoryPhase2Checkpoints.selectionDigest, binding.selectionDigest),
  );
}
export function storageMaintenanceJobCondition(
  binding: MaintenanceReceiptBinding,
  currentTime?: Date,
) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, binding.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, binding.orgId),
    eq(piMemoryPhase2Jobs.userId, binding.userId),
    eq(piMemoryPhase2Jobs.status, "leased"),
    eq(piMemoryPhase2Jobs.leaseToken, binding.leaseToken),
    eq(piMemoryPhase2Jobs.sandboxLeaseToken, binding.leaseToken),
    eq(piMemoryPhase2Jobs.claimedRevision, binding.claimedRevision),
    eq(piMemoryPhase2Jobs.claimedBaseVersionId, binding.claimedBaseVersionId),
    eq(piMemoryPhase2Jobs.claimedSelectionDigest, binding.selectionDigest),
    eq(piMemoryPhase2Jobs.maintenanceRunId, binding.runId),
    currentTime
      ? gt(piMemoryPhase2Jobs.leaseExpiresAt, currentTime)
      : undefined,
  );
}
export function storageCommitLineageCondition(
  storageId: string,
  versionId: string,
  parentVersionId: string,
  runId: string,
) {
  return and(
    eq(storageVersionLineage.storageId, storageId),
    eq(storageVersionLineage.versionId, versionId),
    eq(storageVersionLineage.parentVersionId, parentVersionId),
    eq(storageVersionLineage.runId, runId),
  );
}
export function memoryCandidateOwnerCondition(payload: MaintenancePayload) {
  return and(
    eq(piMemoryStage1Candidates.memoryStorageId, payload.memoryStorageId),
    eq(piMemoryStage1Candidates.orgId, payload.orgId),
    eq(piMemoryStage1Candidates.userId, payload.userId),
  );
}
export function memorySelectedCandidateCondition(
  payload: MaintenancePayload,
  candidate: MaintenancePayload["selected"][number],
) {
  return and(
    memoryCandidateOwnerCondition(payload),
    eq(piMemoryStage1Candidates.status, "succeeded"),
    eq(piMemoryStage1Candidates.piSessionId, candidate.piSessionId),
    eq(piMemoryStage1Candidates.sourceHistoryHash, candidate.sourceHistoryHash),
  );
}
export function externalMemoryHeadChangeCondition(args: {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly observedHeadVersionId: string;
}) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, args.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, args.orgId),
    eq(piMemoryPhase2Jobs.userId, args.userId),
    or(
      isNull(piMemoryPhase2Jobs.lastObservedHeadVersionId),
      ne(
        piMemoryPhase2Jobs.lastObservedHeadVersionId,
        args.observedHeadVersionId,
      ),
    ),
  );
}
export function externalMemoryHeadChangeValues(args: {
  readonly observedHeadVersionId: string;
  readonly changedAt: Date;
  readonly sourceRunId?: string;
}) {
  return {
    status: sql`CASE
        WHEN ${piMemoryPhase2Jobs.maintenanceRunId} = ${args.sourceRunId ?? null}
        THEN ${piMemoryPhase2Jobs.status}
        WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN 'leased'
        ELSE 'pending'
      END`,
    inputRevision: sql`CASE
        WHEN ${piMemoryPhase2Jobs.maintenanceRunId} = ${args.sourceRunId ?? null}
        THEN ${piMemoryPhase2Jobs.inputRevision}
        ELSE ${piMemoryPhase2Jobs.inputRevision} + 1
      END`,
    reconciliationRevision: sql`CASE
        WHEN ${piMemoryPhase2Jobs.maintenanceRunId} = ${args.sourceRunId ?? null}
        THEN ${piMemoryPhase2Jobs.reconciliationRevision}
        ELSE ${piMemoryPhase2Jobs.inputRevision} + 1
      END`,
    claimedRevision: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedRevision}
        ELSE NULL
        END`,
    sandboxLeaseToken: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.sandboxLeaseToken}
        ELSE NULL
      END`,
    maintenanceRunId: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.maintenanceRunId}
        ELSE NULL
      END`,
    claimedBaseVersionId: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedBaseVersionId}
        ELSE NULL
      END`,
    leaseToken: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.leaseToken}
        ELSE NULL
      END`,
    leaseExpiresAt: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.leaseExpiresAt}
        ELSE NULL
      END`,
    retryCount: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.retryCount}
        ELSE 0
      END`,
    retryAt: null,
    lastErrorClass: null,
    claimedSelectionDigest: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectionDigest}
        ELSE NULL
      END`,
    claimedSelectedCount: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectedCount}
        ELSE NULL
      END`,
    claimedSelectedUtf8Bytes: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectedUtf8Bytes}
        ELSE NULL
      END`,
    lastObservedHeadVersionId: args.observedHeadVersionId,
    updatedAt: args.changedAt,
  };
}
export function storageMaintenanceCompletionValues(
  payload: MaintenancePayload,
  runId: string,
  versionId: string,
  completedAt: Date,
) {
  const published = versionId !== payload.claimedBaseVersionId;
  return {
    status: sql`CASE
        WHEN ${piMemoryPhase2Jobs.inputRevision} = ${payload.claimedRevision}
        THEN 'idle'
        ELSE 'pending'
      END`,
    completedRevision: payload.claimedRevision,
    claimedRevision: null,
    claimedBaseVersionId: null,
    leaseToken: null,
    legacyLeaseToken: null,
    sandboxLeaseToken: null,
    leaseExpiresAt: null,
    maintenanceRunId: null,
    retryCount: 0,
    retryAt: null,
    lastErrorClass: null,
    lastSucceededAt: completedAt,
    claimedSelectionDigest: null,
    claimedSelectedCount: null,
    claimedSelectedUtf8Bytes: null,
    ...(published
      ? {
          lastPublishedVersionId: versionId,
          lastPublishedAt: completedAt,
        }
      : {}),
    lastMaintenanceRunId: runId,
    lastMaintenanceRevision: payload.claimedRevision,
    lastMaintenanceBaseVersionId: payload.claimedBaseVersionId,
    lastMaintenanceSelectionDigest: payload.selectionDigest,
    lastMaintenanceCheckpointVersionId: versionId,
    lastMaintenanceOutcome: published
      ? ("published" as const)
      : ("no_diff" as const),
    updatedAt: completedAt,
  };
}
