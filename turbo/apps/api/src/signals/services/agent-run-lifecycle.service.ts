import { command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { deleteS3Objects } from "../external/s3";
import { tapError } from "../utils";
import {
  dispatchCompleteSideEffectsCore$,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";
import { pickOrgQueuedChatThreads$ } from "./chat-thread-queue-drain.service";
import { piSandboxHandoffObjectKey } from "./pi-sandbox-handoff.service";
import type { ReleasedRunSlot } from "./agent-run-terminal-transition.service";

const L = logger("RunLifecycle");

/**
 * After a transaction that called `releaseRunSlots` commits: org-pick each
 * organization that got a slot back, in its own background task per
 * organization, independent of the path's other side effects. Call it before
 * those effects so a failing or slow terminal callback cannot delay it.
 */
export const scheduleReleasedSlotPicks$ = command(
  ({ set }, slots: readonly ReleasedRunSlot[]): void => {
    const orgIds = new Set(
      slots.map((slot) => {
        return slot.orgId;
      }),
    );
    for (const orgId of orgIds) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          set(pickOrgQueuedChatThreads$, { orgId }, backgroundSignal),
          (error) => {
            L.error("Failed to pick organization after slot release", {
              orgId,
              error,
            });
          },
        ),
      );
    }
  },
);

/** Dispatch terminal effects and clean staging data. */
export const dispatchCompleteSideEffects$ = command(
  async (
    { get, set },
    input: DispatchCompleteSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(dispatchCompleteSideEffectsCore$, input, signal);
    signal.throwIfAborted();
    if (input.cleanupPiSandboxHandoff) {
      await tapError(
        get(
          deleteS3Objects(env("R2_USER_STORAGES_BUCKET_NAME"), [
            piSandboxHandoffObjectKey(input.runId, "manifest"),
            piSandboxHandoffObjectKey(input.runId, "session"),
          ]),
        ),
        (error) => {
          L.warn("Failed to release Pi sandbox handoff objects", {
            runId: input.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }
  },
);
