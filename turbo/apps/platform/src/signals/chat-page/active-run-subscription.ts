import { command, computed, state, type Command, type Computed } from "ccstate";
import { createDeferredPromise, resetSignal, setLoop } from "../utils.ts";
import { registerChatEventChangeHandler$ } from "./chat-event-change-registry.ts";
import type { ChatEvent } from "./chat-event-types.ts";

/**
 * Own one operation per active run.
 *
 * `activeRunId$` is the demand. Every time it changes, the previous operation's
 * signal is reset and `startRun$` is invoked with the new run and a fresh
 * signal. Consumers never compare against the previous run: the demand state
 * and its level-triggered reconciliation live here.
 *
 * `startRun$` is expected to stay pending for as long as the run is the demand,
 * so this driver owns that promise instead of the change notification, which
 * cannot await it. A round ends when its signal is reset, and every round
 * re-reads the demand, so a reconcile arriving while the loop sits between
 * rounds is absorbed rather than lost. An operation that fails on its own waits
 * for the next demand change rather than being retried; consumers report their
 * own failures.
 */
export function createActiveRunSubscription(
  chatEvents$: Computed<ChatEvent[]>,
  activeRunId$: Computed<string | null>,
  startRun$: Command<Promise<void>, [string, AbortSignal]>,
) {
  const resetRun$ = resetSignal();
  const demandRunId$ = state<string | null>(null);
  const runId$ = computed((get) => {
    return get(demandRunId$);
  });

  const reconcile$ = command(({ get, set }): void => {
    const runId = get(activeRunId$);
    if (runId === get(demandRunId$)) {
      return;
    }
    set(demandRunId$, runId);
    set(resetRun$);
  });
  const afterEventsChange$ = command(({ set }): Promise<void> => {
    set(reconcile$);
    return Promise.resolve();
  });

  const subscribe$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      set(
        registerChatEventChangeHandler$,
        chatEvents$,
        { command$: afterEventsChange$ },
        signal,
      );
      set(reconcile$);
      await setLoop(
        async () => {
          const runSignal = set(resetRun$, signal);
          const runId = get(demandRunId$);
          // This round ends when its own signal is reset, which is also how the
          // idle round waits for the first run to appear.
          const ended = createDeferredPromise<void>(runSignal);
          if (runId !== null) {
            await Promise.allSettled([set(startRun$, runId, runSignal)]);
            signal.throwIfAborted();
          }
          await Promise.allSettled([ended.promise]);
          signal.throwIfAborted();
          return false;
        },
        0,
        signal,
        { retryTransientErrors: false },
      );
    },
  );

  return { subscribe$, reconcile$, runId$ };
}
