import { command, computed, state, type Command, type Computed } from "ccstate";
import { foldChatRunStates } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent as PersistedChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { sessionOutputDeltaSchema } from "@okouai/api-contracts/contracts/realtime";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  featureSwitchState$,
  registerFeatureSwitchListener$,
} from "../external/feature-switch-state.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { logger } from "../log.ts";
import { setLoop } from "../utils.ts";
import { createActiveRunSubscription } from "./active-run-subscription.ts";
import { liveRunIdsFromChatEvents } from "./chat-event-state.ts";
import {
  appendOptimisticSessionOutput$,
  createOptimisticSessionOutputEventIdsForThread,
} from "./optimistic-chat-events.ts";
import { notifyChatEventsChanged$ } from "./chat-event-change-registry.ts";
import type { ChatEvent } from "./chat-event-types.ts";

const L = logger("SessionOutputStream");
const DURABLE_CONVERGENCE_INTERVAL_MS = 5000;

/** The run whose transient output this thread should be streaming, if any. */
function createActiveRunId$(
  chatEvents$: Computed<ChatEvent[]>,
): Computed<string | null> {
  return computed((get) => {
    if (!get(featureSwitchState$)[FeatureSwitchKey.PiLoop]) {
      return null;
    }
    const events = get(chatEvents$);
    const states = foldChatRunStates(events);
    return (
      liveRunIdsFromChatEvents(events)
        .filter((id) => {
          return states.get(id) !== "queued";
        })
        .at(-1) ?? null
    );
  });
}

export function createSessionOutputStreamSignals(
  threadId: string,
  chatEvents$: Computed<ChatEvent[]>,
  syncDurableEvents$: Command<Promise<void>, [AbortSignal]>,
) {
  const activeRunId$ = createActiveRunId$(chatEvents$);
  const optimisticSessionOutputEventIds$ =
    createOptimisticSessionOutputEventIdsForThread(threadId);
  const convergenceOwnerVersion$ = state(0);
  const syncDurableOutputs$ = command(
    async (
      { get, set },
      ownerVersion: number,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (get(convergenceOwnerVersion$) !== ownerVersion) {
        return true;
      }
      if (get(optimisticSessionOutputEventIds$).length === 0) {
        return false;
      }
      await set(syncDurableEvents$, signal);
      signal.throwIfAborted();
      return get(convergenceOwnerVersion$) !== ownerVersion;
    },
  );
  const receive$ = command(
    async (
      { get, set },
      payload: unknown,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      const result = sessionOutputDeltaSchema.safeParse(payload);
      if (
        !result.success ||
        result.data.threadId !== threadId ||
        result.data.runId !== get(activeRunId$)
      ) {
        return false;
      }
      const events = get(chatEvents$);
      const persisted = events.filter((event): event is PersistedChatEvent => {
        return event.seqId !== undefined;
      });
      if (set(appendOptimisticSessionOutput$, result.data, persisted)) {
        await set(notifyChatEventsChanged$, chatEvents$, signal);
        signal.throwIfAborted();
      }
      return false;
    },
  );
  const streamRunOutput$ = command(
    ({ set }, runId: string, signal: AbortSignal): void => {
      set(
        setAblyPayloadLoop$,
        {
          scope: "run-output",
          topic: runId,
          loopCommand$: receive$,
          options: {
            onError: (error) => {
              L.warn("Session output subscription failed", error);
            },
          },
        },
        signal,
      );
    },
  );
  const stream = createActiveRunSubscription(
    chatEvents$,
    activeRunId$,
    streamRunOutput$,
  );
  const subscribe$ = command(({ get, set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const ownerVersion = get(convergenceOwnerVersion$) + 1;
    set(convergenceOwnerVersion$, ownerVersion);
    // Both the transient publication and the durable invalidation are
    // best-effort. While this thread is visible, read the authoritative tail
    // only when an optimistic output needs its same-ID persistent event.
    // The page-owned loop survives terminal events cancelling the Run owner.
    setLoop(
      (loopSignal) => {
        return set(syncDurableOutputs$, ownerVersion, loopSignal);
      },
      DURABLE_CONVERGENCE_INTERVAL_MS,
      signal,
      { testIntervalMs: 100 },
    );
    const reconcile = set(stream.subscribe$, signal);
    // A switch change moves the demand without producing a chat event.
    set(registerFeatureSwitchListener$, reconcile, signal);
  });
  return { subscribe$ };
}
