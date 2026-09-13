import { and, count, eq } from "drizzle-orm";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryPublicationProvenance } from "@okouai/db/schema/pi-memory-publication-provenance";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";
import {
  admitPiMemoryStage1Candidate,
  deleteStoragesWithPiMemoryCandidates,
  commitPiMemoryStage1Candidate,
  getPiMemoryStage1AdmissionPrerequisiteSkipReason,
  type AdmitPiMemoryStage1CandidateArgs,
  type PiMemoryStage1CommitResult,
} from "../signals/services/pi-memory-stage1-candidate.service";

export function piMemoryStage1AdmissionPrerequisiteSkipReasonFixture(
  overrides: Partial<
    Pick<
      AdmitPiMemoryStage1CandidateArgs,
      | "status"
      | "framework"
      | "generationEnabled"
      | "triggerSource"
      | "chatThreadId"
    >
  > = {},
) {
  return getPiMemoryStage1AdmissionPrerequisiteSkipReason({
    runId: "00000000-0000-4000-8000-000000000001",
    orgId: "org_test",
    userId: "user_test",
    status: "completed",
    framework: "pi",
    generationEnabled: true,
    triggerSource: "web",
    chatThreadId: "00000000-0000-4000-8000-000000000002",
    completedAt: nowDate(),
    idleDelayMs: 30 * 60 * 1000,
    ...overrides,
  });
}

export async function seedPiMemoryPhase2ExportJobFixture(args: {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly currentTime: Date;
}): Promise<{ readonly leaseToken: string; readonly selectionDigest: string }> {
  const leaseToken = "00000000-0000-4000-8000-000000031237";
  const selectionDigest = "a".repeat(64);
  const [storage] = await db()
    .select({ headVersionId: storages.headVersionId })
    .from(storages)
    .where(
      and(
        eq(storages.id, args.memoryStorageId),
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
      ),
    )
    .limit(1);
  if (!storage?.headVersionId) {
    throw new Error("Phase 2 export fixture requires a memory HEAD");
  }
  await db()
    .insert(piMemoryPhase2Jobs)
    .values({
      memoryStorageId: args.memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      status: "leased",
      inputRevision: 2,
      completedRevision: 0,
      reconciliationRevision: 0,
      claimedRevision: 1,
      claimedBaseVersionId: storage.headVersionId,
      leaseToken,
      sandboxLeaseToken: leaseToken,
      leaseExpiresAt: new Date(args.currentTime.getTime() + 60 * 60 * 1000),
      retryCount: 1,
      lastSucceededAt: new Date(
        args.currentTime.getTime() - 24 * 60 * 60 * 1000,
      ),
      claimedSelectionDigest: selectionDigest,
      claimedSelectedCount: 1,
      claimedSelectedUtf8Bytes: 42,
      lastObservedHeadVersionId: storage.headVersionId,
      createdAt: new Date(args.currentTime.getTime() - 2 * 60 * 60 * 1000),
      updatedAt: args.currentTime,
    });
  await db()
    .insert(piMemoryPublicationProvenance)
    .values({
      id: "00000000-0000-4000-8000-000000031258",
      memoryStorageId: args.memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      claimedRevision: 1,
      inputRevision: 1,
      reconciliationRevision: 0,
      selectionDigest,
      selectedCount: 1,
      selectedUtf8Bytes: 42,
      baseVersionId: storage.headVersionId,
      preparedVersionId: "b".repeat(64),
      observedHeadVersionId: "c".repeat(64),
      writer: "pi",
      outcome: "conflicted",
      size: 17,
      archiveSize: 23,
      fileCount: 2,
      createdAt: new Date(args.currentTime.getTime() - 30 * 60 * 1000),
    });
  return { leaseToken, selectionDigest };
}

export async function readPiMemoryStage1CandidateFixture(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  const [candidate] = await db()
    .select({
      memoryStorageId: piMemoryStage1Candidates.memoryStorageId,
      memoryStorageName: storages.name,
      memoryStorageS3Prefix: storages.s3Prefix,
      orgId: piMemoryStage1Candidates.orgId,
      userId: piMemoryStage1Candidates.userId,
      piSessionId: piMemoryStage1Candidates.piSessionId,
      sourceRunId: piMemoryStage1Candidates.sourceRunId,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
      sourceCompletedAt: piMemoryStage1Candidates.sourceCompletedAt,
      eligibleAt: piMemoryStage1Candidates.eligibleAt,
      status: piMemoryStage1Candidates.status,
      leaseToken: piMemoryStage1Candidates.leaseToken,
      leaseExpiresAt: piMemoryStage1Candidates.leaseExpiresAt,
      retryCount: piMemoryStage1Candidates.retryCount,
      rawMemory: piMemoryStage1Candidates.rawMemory,
      rolloutSummary: piMemoryStage1Candidates.rolloutSummary,
      generatedAt: piMemoryStage1Candidates.generatedAt,
      lastSelectedSourceHistoryHash:
        piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
      usageCount: piMemoryStage1Candidates.usageCount,
      updatedAt: piMemoryStage1Candidates.updatedAt,
    })
    .from(piMemoryStage1Candidates)
    .innerJoin(
      storages,
      eq(storages.id, piMemoryStage1Candidates.memoryStorageId),
    )
    .where(
      and(
        eq(piMemoryStage1Candidates.orgId, args.orgId),
        eq(piMemoryStage1Candidates.userId, args.userId),
      ),
    )
    .limit(1);
  return candidate ?? null;
}

export async function countPiMemoryStage1CandidatesFixture(args: {
  readonly memoryStorageId: string;
  readonly piSessionId: string;
}): Promise<number> {
  const [result] = await db()
    .select({ value: count() })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, args.piSessionId),
      ),
    );
  return result?.value ?? 0;
}

export async function readPiConversationIdentityFixture(runId: string) {
  const [conversation] = await db()
    .select({
      piSessionId: conversations.cliAgentSessionId,
      sourceHistoryHash: conversations.cliAgentSessionHistoryHash,
    })
    .from(conversations)
    .where(
      and(eq(conversations.runId, runId), eq(conversations.cliAgentType, "pi")),
    )
    .limit(1);
  if (!conversation?.sourceHistoryHash) {
    throw new Error("Expected hash-backed Pi conversation fixture");
  }
  return conversation;
}

export async function leasePiMemoryStage1CandidateFixture(args: {
  readonly memoryStorageId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}): Promise<void> {
  const [leased] = await db()
    .update(piMemoryStage1Candidates)
    .set({
      status: "leased",
      leaseToken: args.leaseToken,
      leaseExpiresAt: args.leaseExpiresAt,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, args.piSessionId),
        eq(piMemoryStage1Candidates.sourceHistoryHash, args.sourceHistoryHash),
        eq(piMemoryStage1Candidates.status, "pending"),
      ),
    )
    .returning({ memoryStorageId: piMemoryStage1Candidates.memoryStorageId });
  if (!leased) {
    throw new Error("Expected pending Pi memory candidate to be leased");
  }
}

export async function commitPiMemoryStage1CandidateFixture(args: {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
  readonly leaseToken: string;
  readonly committedAt: Date;
  readonly result: PiMemoryStage1CommitResult;
}): Promise<boolean> {
  return await db().transaction(async (tx) => {
    return await commitPiMemoryStage1Candidate(tx, args);
  });
}

export async function setSyntheticPiMemoryStage1SelectionFixture(args: {
  readonly memoryStorageId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
}): Promise<void> {
  const [selected] = await db()
    .update(piMemoryStage1Candidates)
    .set({
      lastSelectedSourceHistoryHash: args.sourceHistoryHash,
    })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, args.piSessionId),
        eq(piMemoryStage1Candidates.sourceHistoryHash, args.sourceHistoryHash),
      ),
    )
    .returning({ memoryStorageId: piMemoryStage1Candidates.memoryStorageId });
  if (!selected) {
    throw new Error("Expected a synthetic Pi memory selection to be recorded");
  }
}

export async function readmitPiMemoryStage1CandidateFixture(
  runId: string,
  ownership: Partial<
    Pick<AdmitPiMemoryStage1CandidateArgs, "orgId" | "userId" | "chatThreadId">
  > = {},
) {
  const [run] = await db()
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      status: agentRuns.status,
      triggerSource: agentRuns.triggerSource,
      chatThreadId: agentRuns.chatThreadId,
      completedAt: agentRuns.completedAt,
      launchSnapshot: agentRuns.launchSnapshot,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  const completedAt = run?.completedAt;
  const launchSnapshot = run?.launchSnapshot;
  if (
    !run ||
    !completedAt ||
    run.status !== "completed" ||
    (launchSnapshot?.schemaVersion !== 2 && launchSnapshot?.schemaVersion !== 3)
  ) {
    throw new Error(
      "Expected a completed V2 or V3 Run for Pi memory readmission",
    );
  }
  return await db().transaction(async (tx) => {
    return await admitPiMemoryStage1Candidate(tx, {
      runId,
      orgId: run.orgId,
      userId: run.userId,
      status: "completed",
      framework: launchSnapshot.framework,
      generationEnabled:
        launchSnapshot.schemaVersion === 2
          ? launchSnapshot.piMemoryGenerationEnabled
          : launchSnapshot.framework === "pi",
      triggerSource: run.triggerSource,
      chatThreadId: run.chatThreadId,
      completedAt,
      idleDelayMs: 0,
      ...ownership,
    });
  });
}

export async function deletePiMemoryStorageFixture(
  memoryStorageId: string,
): Promise<void> {
  const deleted = await db().transaction(async (tx) => {
    return await deleteStoragesWithPiMemoryCandidates(
      tx,
      eq(storages.id, memoryStorageId),
    );
  });
  if (!deleted) {
    throw new Error("Expected Pi memory Storage fixture to be deleted");
  }
}
