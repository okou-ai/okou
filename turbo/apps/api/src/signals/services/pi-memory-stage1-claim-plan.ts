import { QueryBuilder } from "drizzle-orm/pg-core";
import { and, eq, lte, or } from "drizzle-orm";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import type { PiMemoryStage1Selection } from "./pi-memory-stage1-schedule.service";
type ClaimRow = {
  readonly memoryStorageId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
  readonly selection: PiMemoryStage1Selection;
};
export function dueCondition(currentTime: Date) {
  return or(
    and(
      eq(piMemoryStage1Candidates.status, "pending"),
      lte(piMemoryStage1Candidates.eligibleAt, currentTime),
    ),
    and(
      eq(piMemoryStage1Candidates.status, "retryable_failure"),
      lte(piMemoryStage1Candidates.retryAt, currentTime),
    ),
    and(
      eq(piMemoryStage1Candidates.status, "leased"),
      lte(piMemoryStage1Candidates.leaseExpiresAt, currentTime),
    ),
  );
}

export function piMemoryStage1ClaimCandidatePlan(
  row: ClaimRow,
  currentTime: Date,
) {
  return new QueryBuilder()
    .select()
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, row.memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, row.piSessionId),
        eq(piMemoryStage1Candidates.sourceRunId, row.selection.sourceRunId),
        eq(piMemoryStage1Candidates.sourceHistoryHash, row.sourceHistoryHash),
        eq(
          piMemoryStage1Candidates.sourceCompletedAt,
          row.selection.sourceCompletedAt,
        ),
        dueCondition(currentTime),
      ),
    )
    .for("update", { skipLocked: true })
    .as("claim_locked_candidate");
}
export function piMemoryStage1ClaimTerminalPlan(
  row: ClaimRow,
  currentTime: Date,
) {
  return {
    values: {
      status: "terminal_failure" as const,
      leaseToken: null,
      leaseExpiresAt: null,
      retryAt: null,
      lastErrorClass: "attempts_exhausted",
      rawMemory: null,
      rolloutSummary: null,
      rolloutSlug: null,
      generatedAt: null,
      lastSelectedSourceHistoryHash: null,
      updatedAt: currentTime,
    },
    condition: and(
      eq(piMemoryStage1Candidates.memoryStorageId, row.memoryStorageId),
      eq(piMemoryStage1Candidates.piSessionId, row.piSessionId),
      eq(piMemoryStage1Candidates.sourceHistoryHash, row.sourceHistoryHash),
    ),
    returning: { memoryStorageId: piMemoryStage1Candidates.memoryStorageId },
  };
}
export function piMemoryStage1ClaimLeasePlan(
  row: ClaimRow,
  currentTime: Date,
  leaseToken: string,
  reclaimedFailureCount: number,
  leaseMs: number,
) {
  return {
    values: {
      status: "leased" as const,
      leaseToken,
      leaseExpiresAt: new Date(currentTime.getTime() + leaseMs),
      retryAt: null,
      retryCount: reclaimedFailureCount,
      lastErrorClass: null,
      updatedAt: currentTime,
    },
    condition: and(
      eq(piMemoryStage1Candidates.memoryStorageId, row.memoryStorageId),
      eq(piMemoryStage1Candidates.piSessionId, row.piSessionId),
    ),
  };
}
