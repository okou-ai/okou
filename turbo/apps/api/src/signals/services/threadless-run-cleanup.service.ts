import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  deleteRunHistoriesSql,
  deletedRunHistorySchema,
} from "@okouai/db/operations/run-history-deletion";
import { blobs } from "@okouai/db/schema/blob";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { claimedWorkflowAttachments } from "@okouai/db/schema/claimed-workflow-attachment";
import { usageEvent } from "@okouai/db/runtime/usage-event";
import { command } from "ccstate";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";

import {
  deletedRunHistoryReferences,
  conversationReferenceBatches,
  conversationBlobLockCondition,
  conversationBlobReleaseValues,
  conversationDeletionDatabaseError,
  logCommittedConversationDeletion,
} from "./conversation-history-deletion.service";

const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

export interface ThreadlessRunCandidate {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly error: string | null;
  readonly completedAt: Date | null;
  readonly cancellationRecoveryCompleted: boolean | null;
}

function isTerminalStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

function matchesDeletionSnapshot(
  current:
    | Pick<
        ThreadlessRunCandidate,
        "status" | "completedAt" | "cancellationRecoveryCompleted"
      >
    | undefined,
  candidate: ThreadlessRunCandidate,
  quietBefore: Date,
): boolean {
  return !(
    !current ||
    current.status !== candidate.status ||
    current.completedAt?.getTime() !== candidate.completedAt?.getTime() ||
    current.cancellationRecoveryCompleted !==
      candidate.cancellationRecoveryCompleted ||
    !isTerminalStatus(current.status) ||
    current.completedAt === null ||
    current.completedAt > quietBefore
  );
}

const threadlessRunCurrentColumns = Object.freeze({
  status: agentRuns.status,
  completedAt: agentRuns.completedAt,
  cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
});

const deleteThreadlessRunRows$ = command(function deleteIfStillEligible(
  { set },
  candidate: ThreadlessRunCandidate,
  quietBefore: Date,
) {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0264; new non-billing transactions are prohibited.
  return set(writeDb$).transaction(async (tx) => {
    const [current] = await tx
      .select(threadlessRunCurrentColumns)
      .from(agentRuns)
      .where(eq(agentRuns.id, candidate.runId))
      .for("update");
    if (!matchesDeletionSnapshot(current, candidate, quietBefore)) {
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
      await (async () => {
        const runId = candidate.runId;
        const [retained] = await tx
          .select({ id: claimedWorkflowAttachments.runId })
          .from(claimedWorkflowAttachments)
          .where(eq(claimedWorkflowAttachments.runId, runId))
          .limit(1);
        if (retained) {
          return true;
        }
        const [pendingCallback] = await tx
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

        const [runnerJob] = await tx
          .select({ runId: runnerJobQueue.runId })
          .from(runnerJobQueue)
          .where(eq(runnerJobQueue.runId, runId))
          .limit(1);
        if (runnerJob) {
          return true;
        }

        const [pendingUsage] = await tx
          .select({ id: usageEvent.id })
          .from(usageEvent)
          .where(
            and(eq(usageEvent.runId, runId), eq(usageEvent.status, "pending")),
          )
          .limit(1);
        return pendingUsage !== undefined;
      })()
    ) {
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
});

// Keep the original indivisible deletion step free of request cancellation.
// The cron sweep observes abort after its counters through its existing settle.
export const deleteThreadlessRunIfStillEligible$ = command(
  async (
    { set },
    candidate: ThreadlessRunCandidate,
    quietBefore: Date,
  ): Promise<boolean> => {
    const receipt = await set(deleteThreadlessRunRows$, candidate, quietBefore);
    if (receipt === null) {
      return false;
    }
    logCommittedConversationDeletion("threadless", receipt);
    return true;
  },
);
