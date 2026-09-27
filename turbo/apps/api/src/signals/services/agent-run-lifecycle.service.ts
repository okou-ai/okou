import { command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { deleteS3Objects } from "../external/s3";
import { tapError } from "../utils";
import {
  dispatchCompleteSideEffectsCore$,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { pickOrgQueuedChatThreads$ } from "./chat-thread-queue-drain.service";
import { piApiFirstTurnObjectKey } from "./pi-api-first-turn-config";

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

/** Dispatch terminal effects, clean staging data, and release the org slot. */
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
    if (input.kind !== "terminal") {
      return;
    }
    // The run's own thread took its slot over during terminal callbacks; a
    // slot still free goes to the organization's oldest queued thread.
    await tapError(
      set(
        pickOrgQueuedChatThreads$,
        {
          orgId: input.orgId,
          untilFull: false,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        },
        signal,
      ),
      (error) => {
        L.error("Failed to pick queued chat thread", {
          runId: input.runId,
          orgId: input.orgId,
          error,
        });
      },
    );
    signal.throwIfAborted();
  },
);
