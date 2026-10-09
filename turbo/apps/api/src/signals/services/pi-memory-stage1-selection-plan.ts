import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { conversations } from "@okouai/db/schema/conversation";
import { storages } from "@okouai/db/schema/storage";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  piMemoryStage1Days,
  piMemoryStage1Selections,
} from "@okouai/db/schema/pi-memory-stage1-schedule";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { getPiMemoryStage1AdmissionPrerequisiteSkipReason } from "./pi-memory-stage1-admission-plan";
import type { PiMemoryStage1Selection } from "./pi-memory-stage1-schedule.service";

const IDLE_MS = 6 * 60 * 60 * 1000;
const MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
const runActivity = sql`greatest(${agentRuns.createdAt}, ${agentRuns.startedAt}, ${agentRuns.completedAt})`;
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
type SourceRun = Pick<
  typeof agentRuns.$inferSelect,
  keyof typeof sourceRunColumns
>;

/** Pure predicates; the owning command takes these locks in this order. */
function piMemoryStage1SelectionLockConditions(
  selection: PiMemoryStage1Selection,
) {
  return {
    thread: eq(chatThreads.id, selection.chatThreadId),
    storage: and(
      eq(storages.orgId, selection.orgId),
      eq(storages.userId, selection.userId),
      eq(storages.name, MEMORY_ARTIFACT_NAME),
    ),
    day: and(
      eq(piMemoryStage1Days.userId, selection.userId),
      eq(piMemoryStage1Days.orgId, selection.orgId),
      eq(piMemoryStage1Days.day, selection.day),
    ),
    frozen: and(
      eq(piMemoryStage1Selections.userId, selection.userId),
      eq(piMemoryStage1Selections.orgId, selection.orgId),
      eq(piMemoryStage1Selections.day, selection.day),
      eq(piMemoryStage1Selections.slot, selection.slot),
      eq(piMemoryStage1Selections.chatThreadId, selection.chatThreadId),
      eq(piMemoryStage1Selections.memoryStorageId, selection.memoryStorageId),
      eq(piMemoryStage1Selections.piSessionId, selection.piSessionId),
      eq(piMemoryStage1Selections.sourceRunId, selection.sourceRunId),
      eq(
        piMemoryStage1Selections.sourceHistoryHash,
        selection.sourceHistoryHash,
      ),
      eq(
        piMemoryStage1Selections.sourceCompletedAt,
        selection.sourceCompletedAt,
      ),
      eq(piMemoryStage1Selections.sourceActivityAt, selection.sourceActivityAt),
    ),
    features: userFeatureSwitchRowCondition(selection.orgId, selection.userId),
  };
}

const piMemoryStage1FeatureColumns = Object.freeze({
  userId: userFeatureSwitches.userId,
  switches: userFeatureSwitches.switches,
});

export function piMemoryStage1SelectionLockPlans(
  selection: PiMemoryStage1Selection,
) {
  const conditions = piMemoryStage1SelectionLockConditions(selection);
  const builder = new QueryBuilder();
  return {
    thread: builder
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(conditions.thread)
      .for("update")
      .as("selection_locked_thread"),
    storage: builder
      .select({ id: storages.id })
      .from(storages)
      .where(conditions.storage)
      .for("no key update")
      .as("selection_locked_storage"),
    day: builder
      .select()
      .from(piMemoryStage1Days)
      .where(conditions.day)
      .for("update")
      .as("selection_locked_day"),
    frozen: builder
      .select()
      .from(piMemoryStage1Selections)
      .where(conditions.frozen)
      .as("selection_frozen_slot"),
    features: builder
      .select(piMemoryStage1FeatureColumns)
      .from(userFeatureSwitches)
      .where(conditions.features)
      .as("selection_owner_features"),
  };
}

export function piMemoryStage1DayConsumedByAnotherThread(
  selection: PiMemoryStage1Selection,
  day: typeof piMemoryStage1Days.$inferSelect | undefined,
) {
  return !!day?.consumedAt && day.triggerThreadId !== selection.chatThreadId;
}

export function piMemoryStage1LockedSelectionValid(
  selection: PiMemoryStage1Selection,
  evidence: {
    readonly day: typeof piMemoryStage1Days.$inferSelect | undefined;
    readonly frozen: boolean;
    readonly features: readonly Pick<
      typeof userFeatureSwitches.$inferSelect,
      "userId" | "switches"
    >[];
  },
  observedAt: Date,
) {
  return (
    piMemoryStage1DayConsumedByAnotherThread(selection, evidence.day) &&
    evidence.frozen &&
    selection.day === observedAt.toISOString().slice(0, 10) &&
    isFeatureEnabled(
      FeatureSwitchKey.PiMemory,
      featureSwitchContextFromRows(
        selection.orgId,
        selection.userId,
        evidence.features,
      ),
    )
  );
}

/** Four separate reads preserve source gating and latest-activity authority. */
export function piMemoryStage1SelectionSourcePlans(
  selection: PiMemoryStage1Selection,
) {
  const ownerThread = and(
    eq(chatThreads.id, selection.chatThreadId),
    eq(chatThreads.userId, selection.userId),
    eq(agents.orgId, selection.orgId),
  );
  const activityAt =
    sql`greatest(${chatThreads.lastMessageAt}, (select ${max(runActivity)} from ${agentRuns} where ${eq(agentRuns.chatThreadId, chatThreads.id)}))`
      .mapWith(chatThreads.lastMessageAt)
      .as("activity_at");
  return {
    thread: new QueryBuilder()
      .select({ id: chatThreads.id, activityAt })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(ownerThread)
      .limit(1)
      .as("selection_thread_source"),
    active: new QueryBuilder()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, selection.chatThreadId),
          inArray(agentRuns.status, ["pending", "running"]),
        ),
      )
      .limit(1)
      .as("selection_active_source"),
    latest: new QueryBuilder()
      .select(sourceRunColumns)
      .from(agentRuns)
      .where(eq(agentRuns.chatThreadId, selection.chatThreadId))
      .orderBy(desc(runActivity), desc(agentRuns.id))
      .limit(1)
      .as("selection_latest_source"),
  };
}

export function piMemoryStage1SelectionThreadEligible(
  thread: { readonly activityAt: Date } | undefined,
  active: boolean,
  currentTime: Date,
) {
  return (
    !!thread &&
    !active &&
    thread.activityAt.getTime() <= currentTime.getTime() - IDLE_MS &&
    thread.activityAt.getTime() >= currentTime.getTime() - MAX_AGE_MS
  );
}

export function piMemoryStage1SelectionRunEligible(
  run: SourceRun | undefined,
  selection: PiMemoryStage1Selection,
  currentTime: Date,
): run is SourceRun {
  if (
    !run ||
    run.userId !== selection.userId ||
    run.orgId !== selection.orgId ||
    !run.completedAt ||
    run.completedAt.getTime() < currentTime.getTime() - MAX_AGE_MS
  ) {
    return false;
  }
  const snapshot = run.launchSnapshot;
  return !getPiMemoryStage1AdmissionPrerequisiteSkipReason({
    runId: run.id,
    orgId: run.orgId,
    userId: run.userId,
    status: run.status === "completed" ? "completed" : "failed",
    framework: snapshot?.framework ?? null,
    generationEnabled:
      snapshot?.schemaVersion === 2
        ? snapshot.piMemoryGenerationEnabled
        : snapshot?.schemaVersion === 3 && snapshot.framework === "pi",
    triggerSource: run.triggerSource,
    chatThreadId: run.chatThreadId,
    completedAt: run.completedAt,
    idleDelayMs: IDLE_MS,
  });
}

export function piMemoryStage1SelectionConversationPlan(
  selection: PiMemoryStage1Selection,
  latest: SourceRun,
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
        eq(chatThreads.id, selection.chatThreadId),
        eq(chatThreads.agentId, agentSessions.agentId),
      ),
    )
    .where(
      and(
        eq(conversations.runId, latest.id),
        eq(conversations.cliAgentType, "pi"),
        eq(agentSessions.userId, selection.userId),
        eq(agentSessions.orgId, selection.orgId),
      ),
    )
    .limit(1)
    .as("selection_conversation_source");
}

export function piMemoryStage1SelectionSourceMatches(
  selection: PiMemoryStage1Selection,
  latest: SourceRun,
  thread: { readonly activityAt: Date },
  source:
    { readonly piSessionId: string; readonly hash: string | null } | undefined,
) {
  return (
    !!source?.hash &&
    latest.id === selection.sourceRunId &&
    source.hash === selection.sourceHistoryHash &&
    source.piSessionId === selection.piSessionId &&
    thread.activityAt.getTime() === selection.sourceActivityAt.getTime() &&
    latest.completedAt?.getTime() === selection.sourceCompletedAt.getTime()
  );
}
