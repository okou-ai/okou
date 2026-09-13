import { command } from "ccstate";
import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import {
  publishActiveInputToRunnerGroup,
  publishChatThreadDetailChangedSafely,
} from "../external/realtime";
import { tapError } from "../utils";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { staleChatThreadQueueThreadIds } from "./workflow-chat-event-queue.service";
import {
  drainQueuedUserMessagesForThread$,
  type ChatCallbackPreCreateTimingCollector,
} from "./internal-chat-run-callback.service";
import {
  drainWorkflowQueueForThread$,
  type WorkflowQueueDrainResult,
} from "./workflow-queue-drain.service";
import { expiredCancellationRecoveryThreads } from "./chat-active-run.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  pendingActiveInputCondition,
  recentStaleChatQueueWindow,
} from "./chat-event-queue.service";

const DRAIN_SWEEP_LIMIT = 20;
const L = logger("ChatThreadQueueDrain");

type QueueDrainSweepCandidate =
  | {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly reason: "cancellation-recovery-expired";
    }
  | {
      readonly chatThreadId: string;
      readonly queueItemCreatedBefore: Date;
      readonly reason: "queue-item-stale";
    };

interface DrainChatThreadQueueInput {
  readonly apiStartTime?: number;
  readonly chatThreadId: string;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly queueItemCreatedBefore?: Date;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
  readonly automationEventLaunch?: {
    readonly eventId: string;
    readonly apiStartTime: number;
    readonly timing: ApiDispatchTimingCollector;
  };
}

export async function notifyRunningChatRunOfPendingInput(
  db: Db,
  chatThreadId: string,
): Promise<boolean> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      runnerGroup: agentRuns.runnerGroup,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, chatThreadId),
        eq(agentRuns.status, "running"),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  if (!run) {
    return false;
  }
  const [pendingInput] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        pendingActiveInputCondition(db, run.id),
      ),
    )
    .limit(1);
  if (!pendingInput) {
    return false;
  }
  if (run.runnerGroup) {
    await tapError(
      publishActiveInputToRunnerGroup(run.runnerGroup, run.id),
      (error) => {
        L.warn("Failed to notify runner about active input", {
          chatThreadId,
          runId: run.id,
          error,
        });
      },
    );
  }
  return true;
}

/**
 * The single per-thread scheduler entry: terminal run callbacks, cancel,
 * resume, and the stale sweep all converge here. User messages precede workflow automations. The
 * final claims serialize on the same thread row and fold
 * pending events by class priority, then original `created_at` and id.
 *
 * This entry is the designated mounting point for a future unified per-thread
 * rate limiter: admission delays belong here, before either drain half runs.
 */
export const drainChatThreadQueueForThread$ = command(
  async (
    { set },
    input: DrainChatThreadQueueInput,
    signal: AbortSignal,
  ): Promise<WorkflowQueueDrainResult | null> => {
    const schedulerEnteredAt = now();
    const apiStartTime = input.apiStartTime ?? schedulerEnteredAt;
    const db = set(writeDb$);

    const notifiedRunningRun = await notifyRunningChatRunOfPendingInput(
      db,
      input.chatThreadId,
    );
    signal.throwIfAborted();
    if (notifiedRunningRun) {
      return null;
    }

    await set(
      drainQueuedUserMessagesForThread$,
      {
        chatThreadId: input.chatThreadId,
        apiStartTime,
        queueItemCreatedBefore: input.queueItemCreatedBefore,
        timing: input.timing,
      },
      signal,
    );
    signal.throwIfAborted();
    const workflowResult = await set(
      drainWorkflowQueueForThread$,
      {
        chatThreadId: input.chatThreadId,
        apiStartTime,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
        queueItemCreatedBefore: input.queueItemCreatedBefore,
        ...(input.automationEventLaunch
          ? { automationEventLaunch: input.automationEventLaunch }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    return workflowResult;
  },
);

/** Resolve a terminal run's thread before entering the shared scheduler. */
export const drainChatThreadQueueForRun$ = command(
  async (
    { set },
    input: {
      readonly runId: string;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [run] = await db
      .select({ chatThreadId: agentRuns.chatThreadId })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, input.runId), isNotNull(agentRuns.triggerSource)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      return;
    }
    await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId: run.chatThreadId,
        apiStartTime: input.apiStartTime,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
      },
      signal,
    );
  },
);

/** Re-enter the shared scheduler for workflow queues missed by callbacks. */
export const drainStaleChatThreadQueues$ = command(
  async (
    { set },
    input: {
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
      readonly chatThreadIds?: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<number> => {
    if (input.chatThreadIds?.length === 0) {
      return 0;
    }
    const db = set(writeDb$);
    const currentTime = nowDate().getTime();
    const staleWindow = recentStaleChatQueueWindow(currentTime);
    const recoveryExpiredBefore = new Date(
      currentTime - CANCELLATION_RECOVERY_STALE_AFTER_MS,
    );
    const [recoveryThreads, staleThreadIds] = await Promise.all([
      expiredCancellationRecoveryThreads(db, {
        expiredBefore: recoveryExpiredBefore,
        limit: DRAIN_SWEEP_LIMIT,
        chatThreadIds: input.chatThreadIds,
      }),
      staleChatThreadQueueThreadIds(
        db,
        {
          ...staleWindow,
          limit: DRAIN_SWEEP_LIMIT,
          chatThreadIds: input.chatThreadIds,
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    const recoveryThreadIdSet = new Set(
      recoveryThreads.map((thread) => {
        return thread.chatThreadId;
      }),
    );
    const recoveryCandidates: readonly QueueDrainSweepCandidate[] =
      recoveryThreads.map(({ chatThreadId, userId }) => {
        return {
          chatThreadId,
          userId,
          reason: "cancellation-recovery-expired" as const,
        };
      });
    const staleCandidates: readonly QueueDrainSweepCandidate[] = staleThreadIds
      .filter((chatThreadId) => {
        return !recoveryThreadIdSet.has(chatThreadId);
      })
      .map((chatThreadId) => {
        return {
          chatThreadId,
          queueItemCreatedBefore: staleWindow.createdBefore,
          reason: "queue-item-stale" as const,
        };
      });
    // Give both repair paths capacity under sustained backlog, then let either
    // path consume any unused share without raising the existing total limit.
    const reservedPerReason = Math.floor(DRAIN_SWEEP_LIMIT / 2);
    const candidates: readonly QueueDrainSweepCandidate[] = [
      ...recoveryCandidates.slice(0, reservedPerReason),
      ...staleCandidates.slice(0, reservedPerReason),
      ...recoveryCandidates.slice(reservedPerReason),
      ...staleCandidates.slice(reservedPerReason),
    ].slice(0, DRAIN_SWEEP_LIMIT);
    for (const candidate of candidates) {
      await tapError(
        set(
          drainChatThreadQueueForThread$,
          {
            chatThreadId: candidate.chatThreadId,
            dispatchFailedCallbacks: input.dispatchFailedCallbacks,
            queueItemCreatedBefore:
              candidate.reason === "queue-item-stale"
                ? candidate.queueItemCreatedBefore
                : undefined,
          },
          signal,
        ),
        (error) => {
          L.error("Failed to drain stale chat thread queue", {
            chatThreadId: candidate.chatThreadId,
            reason: candidate.reason,
            error,
          });
        },
      );
      signal.throwIfAborted();
      if (candidate.reason === "cancellation-recovery-expired") {
        await publishChatThreadDetailChangedSafely(
          candidate.userId,
          candidate.chatThreadId,
        );
        signal.throwIfAborted();
      }
    }
    return candidates.length;
  },
);
