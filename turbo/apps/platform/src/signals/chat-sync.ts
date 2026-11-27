import { command, computed } from "ccstate";

import { syncAllActiveChatEvents$ } from "./chat-page/chat-event-signal-registry.ts";
import { catchUpChatThreadEventSource$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { forceRefreshChatThreadIndicators$ } from "./chat-page/chat-thread-indicators.ts";
import { syncProjects$ } from "./projects/projects.ts";
import { rootVersion$ } from "./root-signal.ts";
import { detach, Reason, throttleCommand } from "./utils.ts";

const synchronizeChats$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const results = await Promise.allSettled([
      set(catchUpChatThreadEventSource$, signal),
      set(syncProjects$, signal),
      set(forceRefreshChatThreadIndicators$, signal),
      set(syncAllActiveChatEvents$, signal),
    ]);
    signal.throwIfAborted();
    const failure = results.find((result) => {
      return result.status === "rejected";
    });
    if (failure) {
      throw failure.reason;
    }
  },
);

const synchronizeOnContinuityGap$ = computed((get) => {
  get(rootVersion$);
  return throttleCommand(synchronizeChats$, 0);
});

/** Reconcile a real realtime continuity gap using each resource's normal owner. */
export const requestChatSync$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    detach(
      set(get(synchronizeOnContinuityGap$), signal),
      Reason.Daemon,
      "chat synchronization",
    );
  },
);
