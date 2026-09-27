import { command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { deleteS3Objects } from "../external/s3";
import { tapError } from "../utils";
import { writeDb$ } from "../external/db";
import {
  dispatchCompleteSideEffectsCore$,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  pickOrgQueuedChatThreads$,
  pickQueuedChatThread$,
  queueThreadIdForRun,
} from "./chat-thread-queue-drain.service";
import { piApiFirstTurnObjectKey } from "./pi-api-first-turn-config";
import type { ReleasedRunSlot } from "./agent-run-terminal-transition.service";

const L = logger("RunLifecycle");

/** Hand newly available org capacity to queued chat threads. */
export const drainOrgQueueToCapacity$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    const drained = await set(
      pickOrgQueuedChatThreads$,
      {
        orgId: args.orgId,
        untilFull: true,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
    return drained;
  },
);

/**
 * A run's active row was just deleted, so its organization slot is free. The
 * slot goes to the run's own thread first, then to the organization's oldest
 * waiting thread. Every run-end transaction that deletes an active row
 * (Runner completion, cancel, claim failure, cron timeout) calls this after
 * commit and after the run's terminal callbacks, so no end path owns a wakeup
 * of its own. Bulk revocations (membership removal, user deletion or ban) hand
 * off through `handOffReleasedSlots$`; the stale-terminal sweep leaves waiting
 * threads to the cron drain. Every enqueue records its thread as queued, so
 * both picks go through the queued-thread lease and its thread and capacity
 * checks, and the launch's final admission stays authoritative.
 */
export const handOffReleasedSlot$ = command(
  async (
    { set },
    args: { readonly runId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const chatThreadId = await queueThreadIdForRun(set(writeDb$), args.runId);
    signal.throwIfAborted();
    if (chatThreadId) {
      const own = await set(
        pickQueuedChatThread$,
        { chatThreadId, dispatchFailedCallbacks: dispatchFailedRunCallbacks },
        signal,
      );
      signal.throwIfAborted();
      if (own.reason === "launched") {
        return;
      }
    }
    await set(
      pickOrgQueuedChatThreads$,
      {
        orgId: args.orgId,
        untilFull: false,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

/** Hand off every slot a bulk revocation released, once per released run.
 * A failed hand-off is logged and left to the cron drain. */
export const handOffReleasedSlots$ = command(
  async (
    { set },
    slots: readonly ReleasedRunSlot[],
    signal: AbortSignal,
  ): Promise<void> => {
    for (const slot of slots) {
      await tapError(set(handOffReleasedSlot$, slot, signal), (error) => {
        L.error("Failed to hand off revoked run slot", {
          runId: slot.runId,
          orgId: slot.orgId,
          error,
        });
      });
      signal.throwIfAborted();
    }
  },
);

/** Dispatch terminal effects, clean staging data, and hand off a released slot. */
export const dispatchCompleteSideEffects$ = command(
  async (
    { get, set },
    input: DispatchCompleteSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(dispatchCompleteSideEffectsCore$, input, signal);
    signal.throwIfAborted();
    if (input.cleanupPiApiFirstTurn) {
      await tapError(
        get(
          deleteS3Objects(env("R2_USER_STORAGES_BUCKET_NAME"), [
            piApiFirstTurnObjectKey(input.runId, "manifest"),
            piApiFirstTurnObjectKey(input.runId, "session"),
          ]),
        ),
        (error) => {
          L.warn("Failed to release Pi API first-turn staging objects", {
            runId: input.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }
    if (!input.slotReleased) {
      return;
    }
    await tapError(
      set(
        handOffReleasedSlot$,
        { runId: input.runId, orgId: input.orgId },
        signal,
      ),
      (error) => {
        L.error("Failed to hand off released run slot", {
          runId: input.runId,
          orgId: input.orgId,
          error,
        });
      },
    );
    signal.throwIfAborted();
  },
);
