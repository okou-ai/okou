import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { failPendingInlineOnlyDeliveryCallbacksForDeletedThread$ } from "./agent-run-callback.service";
import { dispatchCompleteSideEffects$ } from "./agent-run-lifecycle.service";
import { cancelRun$ } from "./agent-run-terminal-transition.service";
import { dispatchCancelSideEffects$ } from "./run-cancel.service";
import { lockDeletionProtection } from "./threadless-run-protection.service";
import { THREADLESS_RUN_PROTECTIONS } from "./threadless-run-protections";

import {
  deleteLockedRuns,
  deleteRunConversations,
  logCommittedConversationDeletion,
  releaseDeletedConversationReferences,
} from "./conversation-history-deletion.service";

const L = logger("ThreadlessRunCleanup");

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;
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
        ...THREADLESS_RUN_PROTECTIONS.flatMap((protection) => {
          return protection.sweepEligibility(db, { currentTime });
        }),
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
      await lockDeletionProtection(THREADLESS_RUN_PROTECTIONS, tx, {
        runId: candidate.runId,
        orgId: candidate.orgId,
        userId: candidate.userId,
        completedAt: current.completedAt,
      })
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
    candidate: ThreadlessRunCandidate,
    signal: AbortSignal,
  ): Promise<void> {
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

    await set(
      failPendingInlineOnlyDeliveryCallbacksForDeletedThread$,
      candidate.runId,
      signal,
    );
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
                protectThreadlessRuns: true,
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

          await set(redriveTerminalLifecycle$, candidate, signal);
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
