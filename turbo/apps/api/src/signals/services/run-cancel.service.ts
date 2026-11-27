import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import {
  publishCancelToRunnerGroup,
  publishChatThreadDetailChangedSafely,
  publishDesktopShellAuthorizationChangedSafely,
  publishRunQueueChangedForOrgSafely,
} from "../external/realtime";
import { tapError } from "../utils";
import { dispatchRunCallbacks$ } from "./agent-run-callback.service";
import type { CancelRunResult } from "./agent-run-terminal-transition.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { settleDataRouterRun$ } from "./data-router-billing.service";

import { notifyPhoneUseOwner$ } from "./phone-use-notifications.service";

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

    // Independent realtime/phone-use notifications run concurrently.
    await Promise.all([
      set(notifyPhoneUseOwner$, result, signal),
      result.chatThreadId !== null
        ? publishDesktopShellAuthorizationChangedSafely(result.userId)
        : Promise.resolve(),
      publishCancellationRecoveryEntered(result, signal),
      publishRunnerCancellation(result, signal),
      publishRunQueueChangedForOrgSafely(result.orgId),
    ]);
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
      ? await (async () => {
          const runId = result.runId;
          const [callback] = await db
            .select({ id: agentRunCallbacks.id })
            .from(agentRunCallbacks)
            .where(
              and(
                eq(agentRunCallbacks.runId, runId),
                eq(agentRunCallbacks.internalKind, "chat"),
                inArray(agentRunCallbacks.status, ["pending", "failed"]),
              ),
            )
            .limit(1);
          return callback?.id;
        })()
      : undefined;
    signal.throwIfAborted();

    const dispatchCallbacksTask =
      !recoveryRedrive || redriveCallbackId !== undefined
        ? tapError(
            set(
              dispatchRunCallbacks$,
              {
                runId: result.runId,
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
          )
        : Promise.resolve();

    if (recoveryRedrive) {
      await dispatchCallbacksTask;
      signal.throwIfAborted();
      return;
    }

    // A fresh cancellation always came from pending or running, so the
    // cancelled run may have accumulated usage events. Billing reconciliation
    // is independent of terminal callback dispatch, so run both concurrently.
    const billingTask = (async () => {
      await tapError(
        set(settleDataRouterRun$, result.runId, signal),
        (error) => {
          L.error(
            "Data Router cancellation billing failed; no retry scheduled",
            {
              runId: result.runId,
              error,
            },
          );
        },
      );
      signal.throwIfAborted();
      await set(processOrgUsageEvents$, result.orgId, signal);
    })();

    await Promise.all([dispatchCallbacksTask, billingTask]);
    signal.throwIfAborted();
  },
);
