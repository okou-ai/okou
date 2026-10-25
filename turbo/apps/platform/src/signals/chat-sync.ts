import { command, computed, state } from "ccstate";

import { readChatWithRecovery } from "./chat-read-recovery.ts";
import { syncAllActiveChatEvents$ } from "./chat-page/chat-event-signal-registry.ts";
import { catchUpChatThreadEventSource$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { throttleCommand } from "./command-scheduling.ts";
import { rootVersion$ } from "./root-signal.ts";
import { installedSharedDatabaseBridge$ } from "./shared-database-bridge-state.ts";
import { detach, Reason, resetSignal } from "./utils.ts";

const syncRequest$ = state<Promise<void>>(Promise.resolve());
const foregroundVersion$ = state(0);
const resetChatSync$ = resetSignal();

/** The operation's loadable owns pending and failed synchronization UI. */
export const chatSync$ = computed((get) => {
  return get(syncRequest$);
});

const readChats$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const bridge = get(installedSharedDatabaseBridge$);
    const results = await Promise.allSettled([
      set(catchUpChatThreadEventSource$, signal),
      readChatWithRecovery((readSignal) => {
        return bridge.getComputed(
          "chat-thread-indicators",
          { refresh: true },
          readSignal,
        );
      }, signal),
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

export const refreshChatSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    if (document.visibilityState !== "visible") {
      return;
    }
    const requestSignal = set(resetChatSync$, signal);
    const request = set(readChats$, requestSignal);
    set(syncRequest$, request);
    await request;
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
  },
);

const refreshAutomaticChatSync$ = command(
  async ({ get, set }, version: number, signal: AbortSignal): Promise<void> => {
    if (version !== get(foregroundVersion$)) {
      return;
    }
    await set(refreshChatSync$, signal);
    signal.throwIfAborted();
  },
);

const automaticChatSync$ = computed((get) => {
  get(rootVersion$);
  get(foregroundVersion$);
  // Several subscriptions can report the same continuity gap. Keep one active
  // refresh and a trailing catch-up instead of starting a read for every topic.
  return throttleCommand(refreshAutomaticChatSync$, 0);
});

export const requestChatSync$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    if (signal.aborted || document.visibilityState !== "visible") {
      return;
    }
    detach(
      set(get(automaticChatSync$), get(foregroundVersion$), signal),
      Reason.Daemon,
      "chat synchronization",
    );
  },
);

const pauseChatSync$ = command(({ set }): void => {
  set(resetChatSync$);
  // A cancelled read must not remain the predecessor of the next foreground
  // queue. Old queued work also checks this version before starting a read.
  set(foregroundVersion$, (version) => {
    return version + 1;
  });
  set(syncRequest$, Promise.resolve());
});

export const setupChatSyncRecovery$ = command(
  ({ set }, signal: AbortSignal): void => {
    let visibility = document.visibilityState;
    const updateVisibility = () => {
      const next = document.visibilityState;
      if (next === visibility) {
        return;
      }
      visibility = next;
      if (next === "hidden") {
        set(pauseChatSync$);
      } else {
        set(requestChatSync$, signal);
      }
    };
    document.addEventListener("visibilitychange", updateVisibility, { signal });
    window.addEventListener(
      "pagehide",
      () => {
        visibility = "hidden";
        set(pauseChatSync$);
      },
      { signal },
    );
    window.addEventListener("pageshow", updateVisibility, { signal });
    window.addEventListener(
      "online",
      () => {
        set(requestChatSync$, signal);
      },
      { signal },
    );
    signal.addEventListener(
      "abort",
      () => {
        set(pauseChatSync$);
      },
      { once: true },
    );
  },
);
