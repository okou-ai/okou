import { and, eq } from "drizzle-orm";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import { db } from "../lib/db";
import { admitPiMemoryStage1Candidate } from "../signals/services/pi-memory-stage1-candidate.service";
import type { AdmitPiMemoryStage1CandidateArgs } from "../signals/services/pi-memory-stage1-admission-plan";

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
