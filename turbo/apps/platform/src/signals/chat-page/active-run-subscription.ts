import { command, computed, state, type Command, type Computed } from "ccstate";
import { resetSignal } from "../utils.ts";
import { registerChatEventChangeHandler$ } from "./chat-event-change-registry.ts";
import type { ChatEvent } from "./chat-event-types.ts";

/** Reconcile active-run demand and start one background operation per run. */
export function createActiveRunSubscription(
  chatEvents$: Computed<ChatEvent[]>,
  activeRunId$: Computed<string | null>,
  startRun$: Command<void, [string, AbortSignal]>,
) {
  const resetRun$ = resetSignal();
  const ownerVersion$ = state(0);
  const demandRunId$ = state<string | null>(null);
  const runId$ = computed((get) => {
    return get(demandRunId$);
  });

  const reconcile$ = command(({ get, set }, signal: AbortSignal): void => {
    if (signal.aborted) {
      return;
    }
    const runId = get(activeRunId$);
    if (runId === get(demandRunId$)) {
      return;
    }
    set(demandRunId$, runId);
    const runSignal = set(resetRun$, signal);
    if (runId !== null) {
      set(startRun$, runId, runSignal);
    }
  });
  const subscribe$ = command(
    ({ set, get }, signal: AbortSignal): (() => void) => {
      signal.throwIfAborted();
      const ownerVersion = get(ownerVersion$) + 1;
      set(ownerVersion$, ownerVersion);
      set(resetRun$, signal);
      set(demandRunId$, null);
      signal.addEventListener(
        "abort",
        () => {
          if (get(ownerVersion$) === ownerVersion) {
            set(demandRunId$, null);
            set(resetRun$);
          }
        },
        { once: true },
      );
      const reconcile = () => {
        if (get(ownerVersion$) === ownerVersion) {
          set(reconcile$, signal);
        }
      };
      set(
        registerChatEventChangeHandler$,
        chatEvents$,
        { callback: reconcile },
        signal,
      );
      reconcile();
      return reconcile;
    },
  );

  return { subscribe$, runId$ };
}
