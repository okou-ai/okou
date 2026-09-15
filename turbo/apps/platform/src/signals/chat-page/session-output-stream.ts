import { command, computed, type Computed } from "ccstate";
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
import { createActiveRunSubscription } from "./active-run-subscription.ts";
import { liveRunIdsFromChatEvents } from "./chat-event-state.ts";
import { appendOptimisticSessionOutput$ } from "./optimistic-chat-events.ts";
import { notifyChatEventsChanged$ } from "./chat-event-change-registry.ts";
import type { ChatEvent } from "./chat-event-types.ts";

const L = logger("SessionOutputStream");

/** The run whose transient output this thread should be streaming, if any. */
function createActiveRunId$(
  chatEvents$: Computed<ChatEvent[]>,
): Computed<string | null> {
  return computed((get) => {
    if (!get(featureSwitchState$)[FeatureSwitchKey.SessionOutputStreaming]) {
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
) {
  const activeRunId$ = createActiveRunId$(chatEvents$);
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
      }
      return false;
    },
  );
  const streamRunOutput$ = command(
    async ({ set }, runId: string, signal: AbortSignal): Promise<void> => {
      const [result] = await Promise.allSettled([
        set(
          setAblyPayloadLoop$,
          { scope: "run-output", topic: runId, loopCommand$: receive$ },
          signal,
        ),
      ]);
      // A reset ends the round; only a transport failure is worth reporting.
      signal.throwIfAborted();
      if (result.status === "rejected") {
        L.warn("Session output subscription failed", result.reason);
      }
    },
  );
  const stream = createActiveRunSubscription(
    chatEvents$,
    activeRunId$,
    streamRunOutput$,
  );
  const subscribe$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      // A switch change moves the demand without producing a chat event.
      set(
        registerFeatureSwitchListener$,
        () => {
          set(stream.reconcile$);
        },
        signal,
      );
      await set(stream.subscribe$, signal);
    },
  );
  return { subscribe$ };
}
