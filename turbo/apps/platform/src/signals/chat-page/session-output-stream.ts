import { command, computed, state, type Computed } from "ccstate";
import { foldChatRunStates } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent as PersistedChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { sessionOutputDeltaSchema } from "@okouai/api-contracts/contracts/realtime";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  featureSwitchState$,
  registerFeatureSwitchListener$,
} from "../external/feature-switch-state.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { createDeferredPromise, resetSignal, withCleanup } from "../utils.ts";
import { logger } from "../log.ts";
import { liveRunIdsFromChatEvents } from "./chat-event-state.ts";
import { appendOptimisticSessionOutput$ } from "./optimistic-chat-events.ts";
import {
  notifyChatEventsChanged$,
  registerChatEventChangeHandler$,
} from "./chat-event-change-registry.ts";
import type { ChatEvent } from "./chat-event-types.ts";

const L = logger("SessionOutputStream");

export function createSessionOutputStreamSignals(
  threadId: string,
  chatEvents$: Computed<ChatEvent[]>,
) {
  const activeRunId$ = computed((get) => {
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
  const resetSubscription$ = resetSignal();
  const owner$ = state<{
    runId: string | null;
    signal: AbortSignal;
    changed: ReturnType<typeof createDeferredPromise<void>>;
  } | null>(null);

  const reconcile$ = command(({ get, set }): void => {
    const owner = get(owner$);
    if (!owner || owner.signal.aborted || get(activeRunId$) === owner.runId) {
      return;
    }
    set(resetSubscription$, owner.signal);
    if (!owner.changed.settled()) {
      owner.changed.resolve();
    }
  });
  const afterEventsChange$ = command(({ set }): Promise<void> => {
    set(reconcile$);
    return Promise.resolve();
  });
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
  const subscribe$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      set(
        registerChatEventChangeHandler$,
        chatEvents$,
        { command$: afterEventsChange$ },
        signal,
      );
      set(
        registerFeatureSwitchListener$,
        () => {
          set(reconcile$);
        },
        signal,
      );
      await withCleanup(
        (async () => {
          while (!signal.aborted) {
            const runId = get(activeRunId$);
            const subscriptionSignal = set(resetSubscription$, signal);
            const changed = createDeferredPromise<void>(signal);
            set(owner$, { runId, signal, changed });
            // Observe the deferred immediately, including while the transport is
            // attaching. The route owns both waits and cancellation settles both.
            const changeResult = Promise.allSettled([changed.promise]);
            if (runId) {
              const [result] = await Promise.allSettled([
                set(
                  setAblyPayloadLoop$,
                  {
                    scope: "run-output",
                    topic: runId,
                    loopCommand$: receive$,
                  },
                  subscriptionSignal,
                ),
              ]);
              signal.throwIfAborted();
              if (result.status === "rejected" && !subscriptionSignal.aborted) {
                L.warn("Session output subscription failed", result.reason);
              }
            }
            await changeResult;
            signal.throwIfAborted();
          }
        })(),
        () => {
          if (get(owner$)?.signal === signal) {
            set(owner$, null);
            set(resetSubscription$);
          }
        },
      );
    },
  );
  return { subscribe$ };
}
