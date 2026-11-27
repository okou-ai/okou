import { command, computed, state } from "ccstate";
import { chatThreadsContract } from "@okouai/api-contracts/client/chat-threads";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { rootSignal$, rootVersion$ } from "../root-signal.ts";
import { detach, Reason, throttleCommand } from "../utils.ts";
import { clearOptimisticReadMark$ } from "./optimistic-chat-thread-read-marks.ts";

const CHAT_THREAD_INDICATORS_RELOAD_THROTTLE_MS = 1000;

const chatThreadIndicatorsReload$ = state(0);
const chatThreadIndicatorsRefreshVersion$ = state(0);

/** Async computed — reads chat thread indicators from the API. */
export const chatThreadIndicators$ = computed(async (get) => {
  get(chatThreadIndicatorsReload$);
  const client = get(apiClient$)(chatThreadsContract);
  const result = await accept(client.indicators(), [200]);
  return result.body;
});

const reloadChatThreadIndicators$ = command(({ set }) => {
  set(chatThreadIndicatorsReload$, (value) => {
    return value + 1;
  });
});

export const refreshChatThreadIndicators$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(reloadChatThreadIndicators$);
    await get(chatThreadIndicators$);
    signal.throwIfAborted();
  },
);

const chatThreadIndicatorsRefreshThrottle$ = computed((get) => {
  get(rootVersion$);
  get(chatThreadIndicatorsRefreshVersion$);
  return throttleCommand(
    refreshChatThreadIndicators$,
    CHAT_THREAD_INDICATORS_RELOAD_THROTTLE_MS,
  );
});

/**
 * Indicators change only on the server's explicit signals: Run start, Run
 * terminal markers, mute, hide or delete (`chatIndicatorsChanged`), and read
 * cursors. Run output does not refetch them. Run-state signals share the
 * throttle; a user's own read-cursor change or continuity gap refreshes
 * immediately.
 */
export const startChatThreadIndicatorsRefresh$ = command(({ get, set }) => {
  const signal = get(rootSignal$);
  detach(
    set(get(chatThreadIndicatorsRefreshThrottle$), signal),
    Reason.Daemon,
    "chat thread indicators refresh",
  );
});

export const forceRefreshChatThreadIndicators$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(chatThreadIndicatorsRefreshVersion$, (version) => {
      return version + 1;
    });
    await set(refreshChatThreadIndicators$, signal);
  },
);

export const applyChatThreadReadCursorUpdated$ = command(
  ({ set }, payload: unknown) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "threadId" in payload &&
      typeof payload.threadId === "string" &&
      "lastReadAt" in payload &&
      payload.lastReadAt === null
    ) {
      set(clearOptimisticReadMark$, payload.threadId);
    }
  },
);

export const sidebarActiveThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicators$);
    return new Set(
      Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
        return indicator === "active" ? [threadId] : [];
      }),
    );
  },
);
