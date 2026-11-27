import { command, computed } from "ccstate";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";

import { syncActiveChatEvents$ } from "../chat-page/chat-event-signal-registry.ts";
import { catchUpChatThreadEventSource$ } from "../chat-page/chat-thread-event-sourcing.ts";
import {
  applyChatThreadReadCursorUpdated$,
  chatThreadIndicators$,
  refreshChatThreadIndicators$,
  startChatThreadIndicatorsRefresh$,
} from "../chat-page/chat-thread-indicators.ts";
import { requestChatSync$ } from "../chat-sync.ts";
import { logger } from "../log.ts";
import { syncProjects$ } from "../projects/projects.ts";
import { reloadQueueData$ } from "../queue-page/queue-signals.ts";
import {
  setAblyLoop$,
  setAblyPayloadLoop$,
  setForegroundPresence$,
} from "../realtime.ts";
import { rootSignal$, rootVersion$ } from "../root-signal.ts";
import {
  createDeferredPromise,
  detach,
  Reason,
  setLoop,
  throttleCommand,
} from "../utils.ts";
import {
  catchUpChatEventsInDatabase$,
  queryChatThreadEventDatabase$,
  setProjectRealtimeReady$,
} from "./signals.ts";

const L = logger("ChatDatabaseRealtime");

const CHAT_EVENT_CATCH_UP_THROTTLE_MS = 1000;
const RECENT_CHAT_EVENT_CATCH_UP_THREAD_COUNT = 100;

interface RealtimeInboundMessage {
  readonly name?: string | null;
}

function isRealtimeInboundMessage(
  value: unknown,
): value is RealtimeInboundMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (!("name" in value) ||
      value.name === undefined ||
      value.name === null ||
      typeof value.name === "string")
  );
}

const executeCatchUpChatEvent$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const [indicators, threadEvents] = await Promise.all([
      get(chatThreadIndicators$),
      set(
        queryChatThreadEventDatabase$,
        {
          dataKey: { kind: "chat-thread-event" },
          afterSeqId: null,
          consistency: "cache-only",
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    const recentThreadIds = replayChatThreadEvents(
      threadEvents.snapshot?.chatThreads ?? [],
      threadEvents.events,
    )
      .filter((thread) => {
        return !thread.hidden;
      })
      .sort((left, right) => {
        const sortAt = right.sortAt.localeCompare(left.sortAt);
        return sortAt === 0 ? right.id.localeCompare(left.id) : sortAt;
      })
      .slice(0, RECENT_CHAT_EVENT_CATCH_UP_THREAD_COUNT)
      .map((thread) => {
        return thread.id;
      });
    const threadIds = [
      ...new Set([...Object.keys(indicators.threads), ...recentThreadIds]),
    ];
    const updatedThreadIds = await set(
      catchUpChatEventsInDatabase$,
      threadIds,
      signal,
    );
    signal.throwIfAborted();
    await Promise.all(
      updatedThreadIds.map((threadId) => {
        return set(syncActiveChatEvents$, threadId, signal);
      }),
    );
    signal.throwIfAborted();
  },
);

const catchUpChatEventThrottle$ = computed((get) => {
  get(rootVersion$);
  return throttleCommand(
    executeCatchUpChatEvent$,
    CHAT_EVENT_CATCH_UP_THROTTLE_MS,
  );
});

/** Start globally serialized ChatEvent warming without blocking its trigger. */
const startChatEventWarming$ = command(({ get, set }): void => {
  const signal = get(rootSignal$);
  detach(
    set(get(catchUpChatEventThrottle$), signal),
    Reason.Daemon,
    "chat event warming",
  );
});

const handleChatDatabaseRealtimeMessage$ = command(
  ({ set }, payload: unknown, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    if (!isRealtimeInboundMessage(payload)) {
      throw new Error("Chat database realtime message is invalid");
    }
    const topic = payload.name ?? "";
    const threadId = topic.startsWith("chatThreadMessageCreated:")
      ? topic.slice("chatThreadMessageCreated:".length)
      : null;
    if (threadId !== null && threadId.length > 0) {
      // Dispatch the exact thread sync before the broader cache warm.
      // Both run detached so a slow consumer side effect or cache warm cannot
      // hold this realtime payload loop.
      detach(
        set(syncActiveChatEvents$, threadId, signal),
        Reason.Daemon,
        "sync active chat events",
      );
      set(startChatEventWarming$);
      return false;
    }
    if (topic === "threadListChanged") {
      detach(set(syncProjects$, signal), Reason.Daemon, "sync projects");
      detach(
        set(catchUpChatThreadEventSource$, signal),
        Reason.Daemon,
        "catch up chat thread events",
      );
    }
    return false;
  },
);

const startChatThreadIndicatorsRefreshFromRealtime$ = command(
  ({ set }, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    set(startChatThreadIndicatorsRefresh$);
    return false;
  },
);

const reloadChatIndicatorsFromReadCursor$ = command(
  async ({ set }, payload: unknown, signal: AbortSignal): Promise<boolean> => {
    await set(refreshChatThreadIndicators$, signal);
    set(applyChatThreadReadCursorUpdated$, payload);
    signal.throwIfAborted();
    return false;
  },
);

const reloadQueueDataFromRealtime$ = command(
  ({ set }, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    set(reloadQueueData$);
    return false;
  },
);

const setupForegroundPresence$ = command(
  ({ set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    let desiredVisible = document.visibilityState === "visible";
    let waitForChange: ReturnType<typeof createDeferredPromise<void>> | null =
      null;
    const updateVisibility = (visible: boolean): void => {
      desiredVisible = visible;
      if (waitForChange && !waitForChange.settled()) {
        waitForChange.resolve(undefined);
      }
    };
    document.addEventListener(
      "visibilitychange",
      () => {
        updateVisibility(document.visibilityState === "visible");
      },
      { signal },
    );
    window.addEventListener(
      "pageshow",
      () => {
        updateVisibility(document.visibilityState === "visible");
      },
      { signal },
    );
    window.addEventListener(
      "pagehide",
      () => {
        updateVisibility(false);
      },
      { signal },
    );

    let entered = false;
    setLoop(
      async (loopSignal) => {
        const visible = desiredVisible;
        if (visible !== entered) {
          await set(setForegroundPresence$, visible, loopSignal);
          loopSignal.throwIfAborted();
          entered = visible;
        }
        if (desiredVisible === visible) {
          waitForChange = createDeferredPromise<void>(loopSignal);
          await waitForChange.promise;
          loopSignal.throwIfAborted();
        }
        return false;
      },
      0,
      signal,
    );
  },
);

const acquireChatDatabaseRealtime$ = command(
  async (
    { set },
    initialization: Promise<boolean>,
    signal: AbortSignal,
  ): Promise<void> => {
    const projectRealtimeReady = createDeferredPromise<void>(
      { rejection: "owner" },
      signal,
    );
    const authenticated = await initialization;
    signal.throwIfAborted();
    if (!authenticated) {
      return;
    }

    set(setupForegroundPresence$, signal);
    const onError = (error: unknown) => {
      L.warn("chat database realtime subscriptions failed", error);
    };

    set(
      setAblyPayloadLoop$,
      {
        scope: "credential",
        topic: null,
        loopCommand$: handleChatDatabaseRealtimeMessage$,
        includeMessage: true,
        options: {
          onSubscribed: () => {
            if (!projectRealtimeReady.settled()) {
              projectRealtimeReady.resolve();
            }
          },
          onError: (error: unknown) => {
            if (!projectRealtimeReady.settled()) {
              projectRealtimeReady.reject(error);
            }
            onError(error);
          },
          onResync: () => {
            set(requestChatSync$, signal);
          },
        },
      },
      signal,
    );
    set(
      setAblyLoop$,
      {
        scope: "credential",
        topic: "chatIndicatorsChanged",
        loopCommand$: startChatThreadIndicatorsRefreshFromRealtime$,
        // Indicators load lazily on the first read, so subscribing must not
        // fetch them again. Continuity gaps still reload through onResync.
        options: { onError },
      },
      signal,
    );
    set(
      setAblyPayloadLoop$,
      {
        scope: "credential",
        topic: "chatThreadReadCursorUpdated",
        loopCommand$: reloadChatIndicatorsFromReadCursor$,
        options: { onError },
      },
      signal,
    );
    set(
      setAblyLoop$,
      {
        scope: "user",
        topic: "billing:changed",
        loopCommand$: reloadQueueDataFromRealtime$,
        options: {
          onError,
          runOnSubscribe: true,
        },
      },
      signal,
    );
    set(
      setAblyLoop$,
      {
        scope: "org",
        topic: "runQueueChanged",
        loopCommand$: reloadQueueDataFromRealtime$,
        options: { onError },
      },
      signal,
    );

    await projectRealtimeReady.promise;
    signal.throwIfAborted();
  },
);

export const setupChatDatabaseRealtime$ = command(
  (
    { set },
    initialization: Promise<boolean>,
    signal: AbortSignal,
  ): Promise<void> => {
    const ready = set(acquireChatDatabaseRealtime$, initialization, signal);
    set(setProjectRealtimeReady$, ready);
    return ready;
  },
);
