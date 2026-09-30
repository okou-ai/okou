import { command } from "ccstate";
import { waitUntil } from "../context/wait-until";
import {
  dispatchCompleteSideEffectsCore$,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";
import { pickOrgQueuedChatThreads$ } from "./chat-thread-queue-drain.service";
import type { ReleasedRunSlot } from "./agent-run-terminal-transition.service";

/**
 * After the slot release commits: org-pick each
 * organization that got a slot back, in its own background task per
 * organization, independent of the path's other side effects. Call it before
 * those effects so a failing or slow terminal callback cannot delay it.
 */
export const scheduleReleasedSlotPicks$ = command(
  ({ set }, slots: readonly ReleasedRunSlot[], signal: AbortSignal): void => {
    const orgIds = new Set(
      slots.map((slot) => {
        return slot.orgId;
      }),
    );
    for (const orgId of orgIds) {
      waitUntil(set(pickOrgQueuedChatThreads$, { orgId }, signal));
    }
  },
);

/** Dispatch terminal effects. */
export const dispatchCompleteSideEffects$ = command(
  async (
    { set },
    input: DispatchCompleteSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(dispatchCompleteSideEffectsCore$, input, signal);
    signal.throwIfAborted();
  },
);
