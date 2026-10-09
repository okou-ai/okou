import { nowDate } from "../../lib/time";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { newStorageS3Location } from "./storage-s3-prefix.utils";
import { piMemoryStage1WatermarkPlan } from "./pi-memory-stage1-watermark.service";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  max,
  or,
  sql,
} from "drizzle-orm";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { conversations } from "@okouai/db/schema/conversation";
import { storages } from "@okouai/db/schema/storage";
import { blobs } from "@okouai/db/schema/blob";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import {
  piMemoryStage1Days,
  piMemoryStage1Watermarks,
} from "@okouai/db/schema/pi-memory-stage1-schedule";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import {
  getPiMemoryStage1AdmissionPrerequisiteSkipReason,
  type AdmitPiMemoryStage1CandidateArgs,
} from "./pi-memory-stage1-admission-plan";
export const PI_MEMORY_STAGE1_IDLE_MS = 6 * 60 * 60 * 1000;
export const PI_MEMORY_STAGE1_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
const sourceRunColumns = Object.freeze({
  id: agentRuns.id,
  orgId: agentRuns.orgId,
  userId: agentRuns.userId,
  status: agentRuns.status,
  launchSnapshot: agentRuns.launchSnapshot,
  triggerSource: agentRuns.triggerSource,
  chatThreadId: agentRuns.chatThreadId,
  completedAt: agentRuns.completedAt,
  createdAt: agentRuns.createdAt,
  sessionId: agentRuns.sessionId,
});
export type Run = Pick<
  typeof agentRuns.$inferSelect,
  keyof typeof sourceRunColumns
>;
export type Day = typeof piMemoryStage1Days.$inferSelect;
export interface PiMemoryStage1ThreadSource {
  readonly run: Run;
  readonly threadId: string;
  readonly activityAt: Date;
  readonly piSessionId: string;
  readonly hash: string;
}

export function sourceArgs(run: Run) {
  const snapshot = run.launchSnapshot;
  return {
    runId: run.id,
    orgId: run.orgId,
    userId: run.userId,
    status:
      run.status === "completed" ? ("completed" as const) : ("failed" as const),
    framework: snapshot?.framework ?? null,
    generationEnabled:
      snapshot?.schemaVersion === 2
        ? snapshot.piMemoryGenerationEnabled
        : snapshot?.schemaVersion === 3 && snapshot.framework === "pi",
    triggerSource: run.triggerSource,
    chatThreadId: run.chatThreadId,
    completedAt: run.completedAt ?? run.createdAt,
    idleDelayMs: PI_MEMORY_STAGE1_IDLE_MS,
  };
}

export const runActivity = sql`greatest(${agentRuns.createdAt}, ${agentRuns.startedAt}, ${agentRuns.completedAt})`;
export const threadActivity =
  sql`greatest(${chatThreads.lastMessageAt}, (select ${max(runActivity)} from ${agentRuns} where ${eq(agentRuns.chatThreadId, chatThreads.id)}))`.mapWith(
    chatThreads.lastMessageAt,
  );

export function piMemoryScheduleThreadLocks(chosen: readonly string[]) {
  return new QueryBuilder()
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(inArray(chatThreads.id, chosen))
    .orderBy(asc(chatThreads.id))
    .for("update")
    .as("piMemoryScheduleThreadLocks");
}

export function piMemoryScheduleStorageLock(
  request: Pick<Day, "orgId" | "userId">,
) {
  return new QueryBuilder()
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, request.orgId),
        eq(storages.userId, request.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .for("no key update")
    .as("piMemoryScheduleStorageLock");
}

export function piMemoryScheduleDayLock(request: Day) {
  return new QueryBuilder()
    .select()
    .from(piMemoryStage1Days)
    .where(
      and(
        eq(piMemoryStage1Days.userId, request.userId),
        eq(piMemoryStage1Days.day, request.day),
        eq(piMemoryStage1Days.orgId, request.orgId),
        isNull(piMemoryStage1Days.consumedAt),
      ),
    )
    .for("update")
    .as("piMemoryScheduleDayLock");
}

export function piMemoryScheduleOwnerFeatures(
  day: Pick<Day, "orgId" | "userId">,
) {
  return new QueryBuilder()
    .select({
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(userFeatureSwitchRowCondition(day.orgId, day.userId))
    .as("piMemoryScheduleOwnerFeatures");
}

export function piMemoryScheduleThreadSource(
  day: Pick<Day, "orgId" | "userId">,
  threadId: string,
) {
  return new QueryBuilder()
    .select({
      id: chatThreads.id,
      activityAt: threadActivity.as("activity_at"),
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatThreads.id, threadId),
        eq(chatThreads.userId, day.userId),
        eq(agents.orgId, day.orgId),
      ),
    )
    .limit(1)
    .as("piMemoryScheduleThreadSource");
}

export function piMemoryScheduleActiveSource(threadId: string) {
  return new QueryBuilder()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, threadId),
        inArray(agentRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1)
    .as("piMemoryScheduleActiveSource");
}

export function piMemoryScheduleLatestSource(threadId: string) {
  return new QueryBuilder()
    .select(sourceRunColumns)
    .from(agentRuns)
    .where(eq(agentRuns.chatThreadId, threadId))
    .orderBy(desc(runActivity), desc(agentRuns.id))
    .limit(1)
    .as("piMemoryScheduleLatestSource");
}

export function piMemoryScheduleConversation(
  day: Pick<Day, "orgId" | "userId">,
  threadId: string,
  latest: Run,
) {
  return new QueryBuilder()
    .select({
      piSessionId: conversations.cliAgentSessionId,
      hash: conversations.cliAgentSessionHistoryHash,
    })
    .from(conversations)
    .innerJoin(agentSessions, eq(agentSessions.id, latest.sessionId))
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, threadId),
        eq(chatThreads.agentId, agentSessions.agentId),
      ),
    )
    .where(
      and(
        eq(conversations.runId, latest.id),
        eq(conversations.cliAgentType, "pi"),
        eq(agentSessions.userId, day.userId),
        eq(agentSessions.orgId, day.orgId),
      ),
    )
    .limit(1)
    .as("piMemoryScheduleConversation");
}

export function piMemoryScheduleWatermarks(
  day: Pick<Day, "orgId" | "userId">,
  source: PiMemoryStage1ThreadSource,
) {
  return new QueryBuilder()
    .select({
      activityAt: piMemoryStage1Watermarks.sourceActivityAt,
      hash: piMemoryStage1Watermarks.sourceHistoryHash,
    })
    .from(piMemoryStage1Watermarks)
    .where(
      and(
        eq(piMemoryStage1Watermarks.userId, day.userId),
        eq(piMemoryStage1Watermarks.orgId, day.orgId),
        eq(piMemoryStage1Watermarks.chatThreadId, source.threadId),
      ),
    )
    .limit(1)
    .as("piMemoryScheduleWatermarks");
}

export function piMemoryScheduleLegacyEvidence(
  day: Pick<Day, "orgId" | "userId">,
  source: PiMemoryStage1ThreadSource,
) {
  return new QueryBuilder()
    .select({
      activityAt: piMemoryStage1Candidates.sourceCompletedAt,
      hash: piMemoryStage1Candidates.sourceHistoryHash,
    })
    .from(piMemoryStage1Candidates)
    .leftJoin(agentRuns, eq(agentRuns.id, piMemoryStage1Candidates.sourceRunId))
    .where(
      and(
        eq(piMemoryStage1Candidates.orgId, day.orgId),
        eq(piMemoryStage1Candidates.userId, day.userId),
        or(
          eq(agentRuns.chatThreadId, source.threadId),
          eq(piMemoryStage1Candidates.piSessionId, source.piSessionId),
        ),
        inArray(piMemoryStage1Candidates.status, [
          "succeeded",
          "succeeded_no_output",
        ]),
      ),
    )
    .orderBy(desc(piMemoryStage1Candidates.sourceCompletedAt))
    .limit(1)
    .as("piMemoryScheduleLegacyEvidence");
}

export function piMemoryScheduleProductThread(
  args: AdmitPiMemoryStage1CandidateArgs & { readonly chatThreadId: string },
) {
  return new QueryBuilder()
    .select({ id: chatThreads.id })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, agentRuns.chatThreadId),
        eq(chatThreads.agentId, agentSessions.agentId),
      ),
    )
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
        eq(agents.orgId, args.orgId),
      ),
    )
    .limit(1)
    .as("piMemoryScheduleProductThread");
}

export function piMemoryScheduleAdmissionFeatures(
  args: AdmitPiMemoryStage1CandidateArgs,
) {
  return new QueryBuilder()
    .select({
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(userFeatureSwitchRowCondition(args.orgId, args.userId))
    .as("piMemoryScheduleAdmissionFeatures");
}

export function piMemoryScheduleAdmissionSource(
  args: AdmitPiMemoryStage1CandidateArgs,
) {
  return new QueryBuilder()
    .select({
      piSessionId: conversations.cliAgentSessionId,
      sourceHistoryHash: conversations.cliAgentSessionHistoryHash,
    })
    .from(conversations)
    .innerJoin(blobs, eq(conversations.cliAgentSessionHistoryHash, blobs.hash))
    .where(
      and(
        eq(conversations.runId, args.runId),
        eq(conversations.cliAgentType, "pi"),
      ),
    )
    .limit(1)
    .as("piMemoryScheduleAdmissionSource");
}

export function piMemoryScheduleExistingStorage(
  args: Pick<AdmitPiMemoryStage1CandidateArgs, "orgId" | "userId">,
) {
  return new QueryBuilder()
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .for("no key update")
    .limit(1)
    .as("piMemoryScheduleExistingStorage");
}

export function piMemoryScheduleConflictStorage(
  args: Pick<AdmitPiMemoryStage1CandidateArgs, "orgId" | "userId">,
) {
  return new QueryBuilder()
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .for("no key update")
    .limit(1)
    .as("piMemoryScheduleConflictStorage");
}

export function piMemoryScheduleCurrentCandidate(
  memoryStorageId: string,
  admissionSource: AdmissionSource,
) {
  return new QueryBuilder()
    .select({
      sourceCompletedAt: piMemoryStage1Candidates.sourceCompletedAt,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
    })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, admissionSource.piSessionId),
      ),
    )
    .for("update", { of: piMemoryStage1Candidates })
    .limit(1)
    .as("piMemoryScheduleCurrentCandidate");
}

export type AdmissionSource = {
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
};
export function piMemoryCandidateInsertValues(
  args: AdmitPiMemoryStage1CandidateArgs,
  memoryStorageId: string,
  source: AdmissionSource,
) {
  return {
    memoryStorageId,
    orgId: args.orgId,
    userId: args.userId,
    piSessionId: source.piSessionId,
    sourceRunId: args.runId,
    sourceHistoryHash: source.sourceHistoryHash,
    sourceCompletedAt: args.completedAt,
    eligibleAt: new Date(args.completedAt.getTime() + args.idleDelayMs),
    status: "pending" as const,
  };
}
export function piMemoryCandidateReferencePlan(hash: string, change: 1 | -1) {
  return {
    values: {
      refCount:
        change === 1
          ? sql`${blobs.refCount} + 1`
          : sql`${blobs.refCount} - ${1}`,
    },
    condition:
      change === 1
        ? eq(blobs.hash, hash)
        : and(eq(blobs.hash, hash), gte(blobs.refCount, 1)),
    returning: { hash: blobs.hash },
  };
}
export function requirePiMemoryCandidateReference(
  row: { readonly hash: string } | undefined,
  change: 1 | -1,
) {
  if (!row) {
    throw new Error(
      change === 1
        ? "Pi memory candidate source blob does not exist"
        : "Pi memory candidate source blob has no retained reference",
    );
  }
}
export function requirePiMemoryCanonicalStorage(
  row: { readonly id: string } | undefined,
) {
  if (!row) {
    throw new Error("Memory Storage create race produced no canonical row");
  }
  return row.id;
}
function piMemoryCandidateReplacementNeeded(
  current:
    | { readonly sourceCompletedAt: Date; readonly sourceHistoryHash: string }
    | undefined,
  args: AdmitPiMemoryStage1CandidateArgs,
  source: AdmissionSource,
) {
  if (!current) {
    throw new Error("Pi memory candidate conflict produced no canonical row");
  }
  if (current.sourceHistoryHash === source.sourceHistoryHash) {
    return "exact_retry";
  }
  return current.sourceCompletedAt >= args.completedAt
    ? "stale_source"
    : "replace";
}
export function requirePiMemoryCandidateReplacement(
  row: { readonly sourceHistoryHash: string } | undefined,
) {
  if (!row) {
    throw new Error("Locked Pi memory candidate lost its source replacement");
  }
  return row.sourceHistoryHash;
}
export function piMemoryCandidateReplacementPlan(
  candidate: ReturnType<typeof piMemoryCandidateInsertValues>,
  currentHash: string,
  updatedAt: Date,
) {
  return {
    values: {
      sourceRunId: candidate.sourceRunId,
      sourceHistoryHash: candidate.sourceHistoryHash,
      sourceCompletedAt: candidate.sourceCompletedAt,
      eligibleAt: candidate.eligibleAt,
      status: "pending" as const,
      leaseToken: null,
      leaseExpiresAt: null,
      retryAt: null,
      retryCount: 0,
      lastErrorClass: null,
      rawMemory: null,
      rolloutSummary: null,
      rolloutSlug: null,
      generatedAt: null,
      lastSelectedSourceHistoryHash: null,
      usageCount: 0,
      lastUsedAt: null,
      updatedAt,
    },
    condition: and(
      eq(piMemoryStage1Candidates.memoryStorageId, candidate.memoryStorageId),
      eq(piMemoryStage1Candidates.piSessionId, candidate.piSessionId),
      eq(piMemoryStage1Candidates.sourceHistoryHash, currentHash),
    ),
    returning: {
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
    },
  };
}
export function piMemoryScheduleSelectionValues(
  day: Day,
  source: PiMemoryStage1ThreadSource,
  candidate: ReturnType<typeof piMemoryCandidateInsertValues>,
  slot: number,
) {
  return {
    userId: day.userId,
    orgId: day.orgId,
    day: day.day,
    slot,
    chatThreadId: source.threadId,
    memoryStorageId: candidate.memoryStorageId,
    piSessionId: candidate.piSessionId,
    sourceRunId: source.run.id,
    sourceHistoryHash: source.hash,
    sourceCompletedAt: sourceArgs(source.run).completedAt,
    sourceActivityAt: source.activityAt,
  };
}
export function piMemoryScheduleThreadSkipReason(
  thread: { readonly activityAt: Date } | undefined,
  active: boolean,
  currentTime: Date,
) {
  if (!thread) {
    return "stale_selection";
  }
  if (active) {
    return "active_source";
  }
  if (
    thread.activityAt.getTime() >
    currentTime.getTime() - PI_MEMORY_STAGE1_IDLE_MS
  ) {
    return "recent_source";
  }
  if (
    thread.activityAt.getTime() <
    currentTime.getTime() - PI_MEMORY_STAGE1_MAX_AGE_MS
  ) {
    return "old_source";
  }
  return null;
}
function piMemoryScheduleRunSkipReason(
  latest: Run | undefined,
  day: Pick<Day, "userId" | "orgId">,
  currentTime: Date,
) {
  if (
    !latest ||
    latest.userId !== day.userId ||
    latest.orgId !== day.orgId ||
    !latest.completedAt ||
    getPiMemoryStage1AdmissionPrerequisiteSkipReason(sourceArgs(latest))
  ) {
    return "invalid_source";
  }
  return latest.completedAt.getTime() <
    currentTime.getTime() - PI_MEMORY_STAGE1_MAX_AGE_MS
    ? "old_source"
    : null;
}
export function piMemoryScheduleEvidenceUnchanged(
  evidence: readonly {
    readonly hash: string | null;
    readonly activityAt: Date;
  }[],
  source: PiMemoryStage1ThreadSource,
) {
  return evidence.some((row) => {
    return row.hash === source.hash || row.activityAt >= source.activityAt;
  });
}

export interface SelectedDayInput {
  readonly request: Day;
  readonly currentTime: Date;
  readonly chosen: readonly string[];
  readonly skips: Readonly<Record<string, number>>;
}
export function currentDay(day: Day | undefined): day is Day {
  return !!day && day.day === nowDate().toISOString().slice(0, 10);
}
export function ownerEnabled(
  owner: Pick<Day, "orgId" | "userId">,
  rows: readonly Pick<
    typeof userFeatureSwitches.$inferSelect,
    "userId" | "switches"
  >[],
) {
  return isFeatureEnabled(
    FeatureSwitchKey.PiMemory,
    featureSwitchContextFromRows(owner.orgId, owner.userId, rows),
  );
}
export function eligibleRun(
  run: Run | undefined,
  day: Pick<Day, "orgId" | "userId">,
  currentTime: Date,
): run is Run {
  return !!run && !piMemoryScheduleRunSkipReason(run, day, currentTime);
}
export function historyBacked(
  source:
    { readonly piSessionId: string; readonly hash: string | null } | undefined,
): source is { readonly piSessionId: string; readonly hash: string } {
  return !!source?.hash;
}
export function admissionHistoryBacked(
  source:
    | {
        readonly piSessionId: string;
        readonly sourceHistoryHash: string | null;
      }
    | undefined,
): source is AdmissionSource {
  return !!source?.sourceHistoryHash;
}
export function selectedSource(
  run: Run,
  threadId: string,
  thread: { readonly activityAt: Date },
  source: { readonly piSessionId: string; readonly hash: string },
): PiMemoryStage1ThreadSource {
  return {
    run,
    threadId,
    activityAt: thread.activityAt,
    piSessionId: source.piSessionId,
    hash: source.hash,
  };
}
export function orderedEvidence(
  watermarks: readonly {
    readonly activityAt: Date;
    readonly hash: string;
  }[],
  legacy: readonly {
    readonly activityAt: Date;
    readonly hash: string;
  }[],
) {
  return [...watermarks, ...legacy].sort((a, b) => {
    return b.activityAt.getTime() - a.activityAt.getTime();
  });
}
export function admissionAllowed(
  args: AdmitPiMemoryStage1CandidateArgs,
): args is AdmitPiMemoryStage1CandidateArgs & {
  readonly chatThreadId: string;
} {
  return (
    getPiMemoryStage1AdmissionPrerequisiteSkipReason(args) === null &&
    args.chatThreadId !== null
  );
}
export function storageCreation(
  args: Pick<AdmitPiMemoryStage1CandidateArgs, "orgId" | "userId">,
) {
  const location = newStorageS3Location(args.orgId);
  return {
    id: location.storageId,
    orgId: args.orgId,
    userId: args.userId,
    name: MEMORY_ARTIFACT_NAME,
    s3Prefix: location.s3Prefix,
  };
}
export function replacementDecision(
  current:
    | { readonly sourceCompletedAt: Date; readonly sourceHistoryHash: string }
    | undefined,
  args: AdmitPiMemoryStage1CandidateArgs,
  source: AdmissionSource,
) {
  const kind = piMemoryCandidateReplacementNeeded(current, args, source);
  if (!current) {
    throw new Error("Pi memory candidate conflict produced no canonical row");
  }
  return { kind, hash: current.sourceHistoryHash };
}
export function watermarkPlan(
  day: Day,
  threadId: string,
  storageId: string,
  previous: { readonly activityAt: Date; readonly hash: string },
) {
  return piMemoryStage1WatermarkPlan({
    memoryStorageId: storageId,
    orgId: day.orgId,
    userId: day.userId,
    chatThreadId: threadId,
    sourceActivityAt: previous.activityAt,
    sourceHistoryHash: previous.hash,
  });
}
export function decisionLog(
  day: Day,
  count: number,
  skips: Readonly<Record<string, number>>,
) {
  return {
    userId: day.userId,
    orgId: day.orgId,
    day: day.day,
    selectedCount: count,
    outcome: count ? "selected" : "no_eligible_source",
    skips,
  };
}

export function enabledThreads(
  day: Day,
  rows: readonly Pick<
    typeof userFeatureSwitches.$inferSelect,
    "userId" | "switches"
  >[],
  chosen: readonly string[],
) {
  return ownerEnabled(day, rows) ? chosen : [];
}
export function storageIdOf(row: { readonly id: string } | undefined) {
  return row?.id;
}
export function retainedHashOf(
  row: { readonly sourceHistoryHash: string } | undefined,
) {
  return row?.sourceHistoryHash;
}
export function referenceChanges(
  retainHash: string | undefined,
  releaseHash: string | undefined,
) {
  const changes: { readonly hash: string; readonly delta: 1 | -1 }[] = [];
  if (retainHash) {
    changes.push({ hash: retainHash, delta: 1 });
  }
  if (releaseHash) {
    changes.push({ hash: releaseHash, delta: -1 });
  }
  return changes;
}
export function dayConsumptionPlan(day: Day, currentTime: Date) {
  return {
    values: { consumedAt: currentTime },
    condition: eq(piMemoryStage1Days.userId, day.userId),
  };
}
