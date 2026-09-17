import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  exists,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { failPendingInlineOnlyDeliveryCallbacksForDeletedThread } from "./agent-run-callback.service";
import {
  dispatchCompleteSideEffects$,
  drainOrgQueue$,
} from "./agent-run-lifecycle.service";
import { cancelRun$, dispatchCancelSideEffects$ } from "./run-cancel.service";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";
import {
  activePiMemoryPhase2MaintenanceRunCondition,
  lockPiMemoryPhase2MaintenanceCleanupProtection,
} from "./pi-memory-phase2-maintenance.service";
import {
  loadPiMemoryPhase2UsageBinding,
  piMemoryPhase2ProviderCondition,
  PI_MEMORY_PHASE2_USAGE_DRAIN_MS,
  PI_MEMORY_PHASE2_MODEL,
} from "./pi-memory-phase2-usage.service";

import {
  deleteLockedRuns,
  deleteRunConversations,
  logCommittedConversationDeletion,
  releaseDeletedConversationReferences,
} from "./conversation-history-deletion.service";

const L = logger("ThreadlessRunCleanup");

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

const THREADLESS_RUN_SWEEP_LIMIT = 20;

// The audited legacy cohort predates this issue. It must remain untouched until
// a separately gated data migration. Newer runs are unambiguously forward
// lifecycle rows. Older runs enter the forward cohort only when their durable
// chat callback can be matched to a post-cutoff thread-deletion tombstone.
const THREADLESS_RUN_FORWARD_CUTOFF_ISO = "2026-08-03T05:40:26.000Z";

interface ThreadlessRunCandidate {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly error: string | null;
  readonly completedAt: Date | null;
  readonly cancellationRecoveryCompleted: boolean | null;
}

interface ThreadlessRunCleanupError {
  readonly runId: string;
  readonly error: string;
}

export interface ThreadlessRunCleanupResult {
  readonly discovered: number;
  readonly cancelled: number;
  readonly waiting: number;
  readonly deleted: number;
  readonly failed: number;
  readonly errors: readonly ThreadlessRunCleanupError[];
}

function isActiveStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

function isTerminalStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalError(candidate: ThreadlessRunCandidate): string | undefined {
  if (candidate.status === "completed") {
    return undefined;
  }
  if (candidate.error) {
    return candidate.error;
  }
  if (candidate.status === "cancelled") {
    return "Run cancelled";
  }
  if (candidate.status === "timeout") {
    return "Run timed out";
  }
  return "Run failed";
}

async function loadThreadlessRunCandidates(
  db: Db,
  runIds: readonly string[] | null,
  currentTime: Date,
): Promise<readonly ThreadlessRunCandidate[]> {
  const forwardCutoff = new Date(THREADLESS_RUN_FORWARD_CUTOFF_ISO);
  const usageQuietBefore = new Date(
    currentTime.getTime() - PI_MEMORY_PHASE2_USAGE_DRAIN_MS,
  );
  return await db
    .select({
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      status: agentRuns.status,
      error: agentRuns.error,
      completedAt: agentRuns.completedAt,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
    })
    .from(agentRuns)
    .where(
      and(
        isNotNull(agentRuns.triggerSource),
        isNull(agentRuns.chatThreadId),
        ne(agentRuns.triggerSource, "test"),
        inArray(agentRuns.status, [
          ...ACTIVE_RUN_STATUSES,
          ...TERMINAL_RUN_STATUSES,
        ]),
        notExists(
          db
            .select({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId })
            .from(piMemoryPhase2Jobs)
            .where(
              activePiMemoryPhase2MaintenanceRunCondition(db, {
                runId: agentRuns.id,
                orgId: agentRuns.orgId,
                userId: agentRuns.userId,
                currentTime,
              }),
            ),
        ),
        // Do not let retained private billing contexts occupy the bounded
        // sweep and starve ordinary threadless cleanup. Revalidate under lock.
        notExists(
          db
            .select({ id: agentRunCallbacks.id })
            .from(agentRunCallbacks)
            .where(
              and(
                eq(agentRunCallbacks.runId, agentRuns.id),
                eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
                eq(
                  sql`${agentRunCallbacks.payload}->>'orgId'`,
                  agentRuns.orgId,
                ),
                eq(
                  sql`${agentRunCallbacks.payload}->>'userId'`,
                  agentRuns.userId,
                ),
                eq(agentRuns.triggerSource, "agent"),
                piMemoryPhase2ProviderCondition(),
                eq(agentRuns.selectedModel, PI_MEMORY_PHASE2_MODEL),
                eq(sql`${agentRuns.launchSnapshot}->>'framework'`, "pi"),
                gt(agentRuns.completedAt, usageQuietBefore),
              ),
            ),
        ),
        runIds === null ? undefined : inArray(agentRuns.id, runIds),
        or(
          gte(agentRuns.createdAt, forwardCutoff),
          exists(
            db
              .select({ id: chatThreadEvents.id })
              .from(agentRunCallbacks)
              .innerJoin(
                chatThreadEvents,
                and(
                  eq(chatThreadEvents.userId, agentRuns.userId),
                  eq(chatThreadEvents.orgId, agentRuns.orgId),
                  eq(chatThreadEvents.kind, "deleted"),
                  gte(chatThreadEvents.createdAt, forwardCutoff),
                  eq(
                    sql`${agentRunCallbacks.payload}->>'threadId'`,
                    sql`${chatThreadEvents.chatThreadId}::text`,
                  ),
                ),
              )
              .where(
                and(
                  eq(agentRunCallbacks.runId, agentRuns.id),
                  eq(agentRunCallbacks.internalKind, "chat"),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id))
    .limit(THREADLESS_RUN_SWEEP_LIMIT);
}

function quietWindowElapsed(
  candidate: ThreadlessRunCandidate,
  quietBefore: Date,
): boolean {
  return candidate.completedAt !== null && candidate.completedAt <= quietBefore;
}

async function hasDeletionBlocker(
  db: Pick<Db, "select">,
  runId: string,
): Promise<boolean> {
  const [pendingCallback] = await db
    .select({ id: agentRunCallbacks.id })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingCallback) {
    return true;
  }

  const [queuedRun] = await db
    .select({ runId: agentRunQueue.runId })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.runId, runId))
    .limit(1);
  if (queuedRun) {
    return true;
  }

  const [runnerJob] = await db
    .select({ runId: runnerJobQueue.runId })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  if (runnerJob) {
    return true;
  }

  const [pendingUsage] = await db
    .select({ id: usageEvent.id })
    .from(usageEvent)
    .where(and(eq(usageEvent.runId, runId), eq(usageEvent.status, "pending")))
    .limit(1);
  return pendingUsage !== undefined;
}

async function deleteIfStillEligible(
  db: Db,
  candidate: ThreadlessRunCandidate,
  quietBefore: Date,
): Promise<boolean> {
  const receipt = await db.transaction(async (tx) => {
    // Account cleanup and compaction hold ledger rows before Runs. Exclude
    // that maintenance before our Run-delete FK acquires ledger-row locks.
    await lockUsageEventCompaction(tx, "shared");
    const [current] = await tx
      .select({
        status: agentRuns.status,
        completedAt: agentRuns.completedAt,
        cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, candidate.runId))
      .for("update");
    if (
      !current ||
      current.status !== candidate.status ||
      current.completedAt?.getTime() !== candidate.completedAt?.getTime() ||
      current.cancellationRecoveryCompleted !==
        candidate.cancellationRecoveryCompleted ||
      !isTerminalStatus(current.status) ||
      current.completedAt === null ||
      current.completedAt > quietBefore
    ) {
      return null;
    }

    const [metadataRun] = await tx
      .select({ chatThreadId: agentRuns.chatThreadId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, candidate.runId),
          isNotNull(agentRuns.triggerSource),
        ),
      )
      .limit(1);
    if (!metadataRun || metadataRun.chatThreadId !== null) {
      return null;
    }

    if (
      await lockPiMemoryPhase2MaintenanceCleanupProtection(tx, {
        runId: candidate.runId,
        orgId: candidate.orgId,
        userId: candidate.userId,
      })
    ) {
      return null;
    }

    if (
      current.completedAt.getTime() >
        nowDate().getTime() - PI_MEMORY_PHASE2_USAGE_DRAIN_MS &&
      (await loadPiMemoryPhase2UsageBinding(tx, candidate))
    ) {
      return null;
    }

    if (await hasDeletionBlocker(tx, candidate.runId)) {
      return null;
    }

    const removed = await deleteRunConversations(tx, [candidate.runId]);
    await deleteLockedRuns(tx, [candidate.runId]);
    return await releaseDeletedConversationReferences(tx, removed);
  });
  if (receipt === null) {
    return false;
  }
  logCommittedConversationDeletion("threadless", receipt);
  return true;
}

const redriveTerminalLifecycle$ = command(
  async function redriveTerminalLifecycle(
    { set },
    args: { readonly db: Db; readonly candidate: ThreadlessRunCandidate },
    signal: AbortSignal,
  ): Promise<void> {
    const { db, candidate } = args;
    if (candidate.status === "cancelled") {
      const cancelResult = await set(
        cancelRun$,
        {
          runId: candidate.runId,
          userId: candidate.userId,
          orgId: candidate.orgId,
          runnerCancellationMode: "hard",
          preserveExistingCancellation: true,
        },
        signal,
      );
      signal.throwIfAborted();
      if ("alreadyCancelled" in cancelResult) {
        await set(dispatchCancelSideEffects$, cancelResult, signal);
        signal.throwIfAborted();
      }
    }

    const error = terminalError(candidate);
    await set(
      dispatchCompleteSideEffects$,
      {
        kind: "terminal",
        runId: candidate.runId,
        orgId: candidate.orgId,
        status: candidate.status === "completed" ? "completed" : "failed",
        ...(error === undefined ? {} : { error }),
      },
      signal,
    );
    signal.throwIfAborted();

    await failPendingInlineOnlyDeliveryCallbacksForDeletedThread(
      db,
      candidate.runId,
    );
    signal.throwIfAborted();

    // dispatchCompleteSideEffects$ treats queue publication as best effort for
    // normal webhooks. Deletion requires a strict durable reconciliation pass.
    await set(drainOrgQueue$, { orgId: candidate.orgId }, signal);
    signal.throwIfAborted();
  },
);

export const cleanupThreadlessRuns$ = command(
  async (
    { set },
    runIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<ThreadlessRunCleanupResult> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const candidates = await loadThreadlessRunCandidates(
      db,
      runIds,
      currentTime,
    );
    signal.throwIfAborted();

    let cancelled = 0;
    let waiting = 0;
    let deleted = 0;
    const errors: ThreadlessRunCleanupError[] = [];
    const quietBefore = new Date(
      currentTime.getTime() - CANCELLATION_RECOVERY_STALE_AFTER_MS,
    );

    for (const candidate of candidates) {
      const result = await settle(
        (async () => {
          if (isActiveStatus(candidate.status)) {
            const cancelResult = await set(
              cancelRun$,
              {
                runId: candidate.runId,
                userId: candidate.userId,
                orgId: candidate.orgId,
                runnerCancellationMode: "hard",
                preserveExistingCancellation: true,
                protectActivePiMemoryPhase2Maintenance: true,
              },
              signal,
            );
            signal.throwIfAborted();
            if (!("alreadyCancelled" in cancelResult)) {
              waiting++;
              return;
            }
            await set(dispatchCancelSideEffects$, cancelResult, signal);
            signal.throwIfAborted();
            cancelled++;
            return;
          }

          if (!quietWindowElapsed(candidate, quietBefore)) {
            waiting++;
            return;
          }

          await set(redriveTerminalLifecycle$, { db, candidate }, signal);
          signal.throwIfAborted();
          if (await deleteIfStillEligible(db, candidate, quietBefore)) {
            deleted++;
          } else {
            waiting++;
          }
        })(),
        signal,
      );
      if (!result.ok) {
        errors.push({
          runId: candidate.runId,
          error: errorMessage(result.error),
        });
      }
    }

    const cleanupResult = {
      discovered: candidates.length,
      cancelled,
      waiting,
      deleted,
      failed: errors.length,
      errors,
    };
    if (candidates.length > 0) {
      L.debug("Threadless run cleanup completed", cleanupResult);
    }
    return cleanupResult;
  },
);
