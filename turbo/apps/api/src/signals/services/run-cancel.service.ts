import { command } from "ccstate";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import {
  publishCancelToRunnerGroup,
  publishChatThreadDetailChangedSafely,
  publishRunQueueChangedForOrgSafely,
} from "../external/realtime";
import { tapError } from "../utils";
import {
  dispatchRunCallbacks$,
  undeliveredChatCallbackIdForRun,
} from "./agent-run-callback.service";
import type { CancelRunResult } from "./agent-run-terminal-transition.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";

const L = logger("RunCancel");

export function shouldDispatchCancelSideEffects(
  result: CancelRunResult,
): boolean {
  return (
    !result.alreadyCancelled ||
    result.cancellationRecoveryCompleted !== null ||
    result.runnerCancellationChanged
  );
}

async function publishCancellationRecoveryEntered(
  result: CancelRunResult,
  signal: AbortSignal,
): Promise<void> {
  if (
    result.alreadyCancelled ||
    result.cancellationRecoveryCompleted === null ||
    result.chatThreadId === null
  ) {
    return;
  }
  await publishChatThreadDetailChangedSafely(
    result.userId,
    result.chatThreadId,
  );
  signal.throwIfAborted();
}

async function publishRunnerCancellation(
  result: CancelRunResult,
  signal: AbortSignal,
): Promise<void> {
  if (
    !result.runnerCancellationChanged ||
    (!result.alreadyCancelled && result.previousStatus !== "running") ||
    !result.runnerGroup ||
    result.runnerCancellationMode === null
  ) {
    return;
  }
  await tapError(
    publishCancelToRunnerGroup(
      result.runnerGroup,
      result.runId,
      result.runnerCancellationMode,
    ),
    (error) => {
      L.error("Failed to publish cancel to runner group", {
        runId: result.runId,
        runnerGroup: result.runnerGroup,
        error,
      });
    },
  );
  signal.throwIfAborted();
}

/**
 * Post-cancel side effects:
 *  - Notify the runner group to halt the cancelled run (if it was
 *    running on a runner).
 *  - Reconcile credits via `processOrgUsageEvents$`. The transactional
 *    invariant (events marked processed iff credit deduction succeeds) is
 *    preserved by `processOrgUsageEvents$`.
 *
 * Deferrals (tracked under #12290):
 *  - `triggerAutoRecharge` (Stripe top-up) — sibling follow-up.
 *
 * Fire-and-forget caller: invoke from the route handler via `waitUntil(...)`
 * with a detached background signal after `cancelRun$` commits.
 */
export const dispatchCancelSideEffects$ = command(
  async (
    { set },
    result: CancelRunResult,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!shouldDispatchCancelSideEffects(result)) {
      return;
    }
    const recoveryRedrive = result.alreadyCancelled;
    const db = set(writeDb$);
    await publishCancellationRecoveryEntered(result, signal);
    await publishRunnerCancellation(result, signal);
    await publishRunQueueChangedForOrgSafely(result.orgId);
    signal.throwIfAborted();

    // A hard upgrade must not revive legacy terminal effects that were already suppressed.
    if (
      result.alreadyCancelled &&
      result.cancellationRecoveryCompleted === null
    ) {
      return;
    }

    // An undelivered source callback still owns its post-marker work: delivery
    // registration and chat-run-finished automation admission commit after the
    // lifecycle marker, and its replay is idempotent. An acknowledged callback
    // already committed that work and is never replayed.
    const redriveCallbackId = recoveryRedrive
      ? await undeliveredChatCallbackIdForRun(db, result.runId)
      : undefined;
    signal.throwIfAborted();
    if (!recoveryRedrive || redriveCallbackId !== undefined) {
      await tapError(
        set(
          dispatchRunCallbacks$,
          {
            runId: result.runId,
            status: "failed",
            error: "Run cancelled",
            ...(redriveCallbackId !== undefined
              ? { redriveChatCallbackId: redriveCallbackId }
              : {}),
          },
          signal,
        ),
        (error) => {
          L.error("Failed to dispatch cancel callbacks", {
            runId: result.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    if (recoveryRedrive) {
      return;
    }

    // A fresh cancellation always came from pending or running, so the
    // cancelled run may have accumulated usage events.
    await set(processOrgUsageEvents$, result.orgId, signal);
    signal.throwIfAborted();
  },
);
