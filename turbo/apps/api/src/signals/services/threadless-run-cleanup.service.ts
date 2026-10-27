import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  deleteRunHistoriesSql,
  deletedRunHistorySchema,
} from "@okouai/db/operations/run-history-deletion";
import { blobs } from "@okouai/db/schema/blob";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { claimedWorkflowAttachments } from "@okouai/db/schema/claimed-workflow-attachment";
import { usageEvent } from "@okouai/db/runtime/usage-event";
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
import { parseRawRows } from "../../lib/db-raw-rows";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { failPendingInlineOnlyDeliveryCallbacksForDeletedThread$ } from "./agent-run-callback.service";
import { dispatchCompleteSideEffects$ } from "./agent-run-lifecycle.service";
import { cancelRun$ } from "./agent-run-terminal-transition.service";
import { dispatchCancelSideEffects$ } from "./run-cancel.service";

import {
  deletedRunHistoryReferences,
  conversationReferenceBatches,
  conversationBlobLockCondition,
  conversationBlobReleaseValues,
  conversationDeletionDatabaseError,
  logCommittedConversationDeletion,
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

function threadlessRunCandidateReadPlan() {
  const forwardCutoff = new Date(THREADLESS_RUN_FORWARD_CUTOFF_ISO);
  return {
    selection: {
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      status: agentRuns.status,
      error: agentRuns.error,
      completedAt: agentRuns.completedAt,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
    },
    conditions: [
      isNotNull(agentRuns.triggerSource),
      isNull(agentRuns.chatThreadId),
      ne(agentRuns.triggerSource, "test"),
      inArray(agentRuns.status, [
        ...ACTIVE_RUN_STATUSES,
        ...TERMINAL_RUN_STATUSES,
      ]),
    ],
    forwardCohort: gte(agentRuns.createdAt, forwardCutoff),
    deletedThread: {
      selection: { id: chatThreadEvents.id },
      join: and(
        eq(chatThreadEvents.userId, agentRuns.userId),
        eq(chatThreadEvents.orgId, agentRuns.orgId),
        eq(chatThreadEvents.kind, "deleted"),
        gte(chatThreadEvents.createdAt, forwardCutoff),
        eq(
          sql`${agentRunCallbacks.payload}->>'threadId'`,
          sql`${chatThreadEvents.chatThreadId}::text`,
        ),
      ),
      condition: and(
        eq(agentRunCallbacks.runId, agentRuns.id),
        eq(agentRunCallbacks.internalKind, "chat"),
      ),
    },
  };
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
  const [retained] = await db
    .select({ id: claimedWorkflowAttachments.runId })
    .from(claimedWorkflowAttachments)
    .where(eq(claimedWorkflowAttachments.runId, runId))
    .limit(1);
  if (retained) {
    return true;
  }
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
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0264; new non-billing transactions are prohibited.
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

    if (await hasDeletionBlocker(tx, candidate.runId)) {
      return null;
    }

    const runIds = [candidate.runId];
    const historyDeletionQuery = deleteRunHistoriesSql(runIds);
    const historyDeletionSchema = deletedRunHistorySchema;
    const deletion = await settle(
      (async () => {
        return parseRawRows(
          historyDeletionSchema,
          await tx.execute(historyDeletionQuery),
        );
      })(),
    );
    if (!deletion.ok) {
      throw conversationDeletionDatabaseError(deletion.error);
    }
    const rows = deletion.value;
    if (rows.length !== runIds.length) {
      throw new Error("Conversation deletion lost a locked run");
    }
    const removed = deletedRunHistoryReferences(rows);

    // Release references LAST in the same transaction, after all parent work.
    const release = conversationReferenceBatches(removed);
    for (const batch of release.batches) {
      // Keep the existing global hash order and nonblocking acquisition.
      const locked = await settle(
        tx
          .select({ hash: blobs.hash })
          .from(blobs)
          .where(conversationBlobLockCondition(batch))
          .orderBy(asc(blobs.hash))
          .for("update", { noWait: true }),
      );
      if (!locked.ok) {
        throw conversationDeletionDatabaseError(locked.error);
      }
      // Do not let a concurrent INSERT replace a missing old retain.
      if (locked.value.length !== batch.length) {
        throw new Error(
          "Conversation history reference accounting failed: missing blob references",
        );
      }
      const releaseValues = conversationBlobReleaseValues(batch);
      const released = await settle(
        tx
          .update(blobs)
          .set(releaseValues.values)
          .from(releaseValues.from)
          .where(releaseValues.where),
      );
      if (!released.ok) {
        throw conversationDeletionDatabaseError(released.error);
      }
      if (released.value.rowCount !== batch.length) {
        throw new Error(
          "Conversation history reference accounting failed: missing or insufficient blob references",
        );
      }
    }
    return release.receipt;
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
        firstTerminalTransition: false,
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
  async ({ set }, signal: AbortSignal): Promise<ThreadlessRunCleanupResult> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const candidates = await (async (): Promise<
      readonly ThreadlessRunCandidate[]
    > => {
      const plan = threadlessRunCandidateReadPlan();
      return await db
        .select(plan.selection)
        .from(agentRuns)
        .where(
          and(
            ...plan.conditions,
            or(
              plan.forwardCohort,
              exists(
                db
                  .select(plan.deletedThread.selection)
                  .from(agentRunCallbacks)
                  .innerJoin(chatThreadEvents, plan.deletedThread.join)
                  .where(plan.deletedThread.condition),
              ),
            ),
          ),
        )
        .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id))
        .limit(THREADLESS_RUN_SWEEP_LIMIT);
    })();
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
