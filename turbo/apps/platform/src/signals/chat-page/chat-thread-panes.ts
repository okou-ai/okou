import { command, computed, state, type Command } from "ccstate";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { activeRoute$ } from "../active-route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { logger } from "../log.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import type { DraftSignals } from "../okou-page/chat-draft.ts";
import { createChatPanelSignals, ensureDraft$ } from "./create-chat-thread.ts";
import type { ChatPanelSignals } from "./chat-panel-signals.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import {
  type ChatThreadPaneState,
  currentLeftPane$,
  currentLeftThread$,
  currentRightPane$,
  currentRightThread$,
  setCurrentLeftPane$,
  setCurrentRightPane$,
} from "./chat-thread-pane-state.ts";
import {
  syncMissingPrimaryThread$,
  syncPrimaryThread$,
} from "./sync-primary-thread.ts";

export const SIDEBAR_PARAM = "sidebar";
export {
  currentLeftPane$,
  currentLeftThread$,
  currentRightPane$,
  currentRightThread$,
};

const L = logger("ChatPanes");

interface ChatThreadTarget {
  readonly threadId: string;
  readonly agentId: string;
  readonly draft: DraftSignals;
}

interface ChatThreadPaneSignals {
  /**
   * Show a thread, binding its panel to the pane's current setup lifetime,
   * and publish the pane state the page renders from.
   */
  readonly loadThread$: Command<ChatPanelSignals, [ChatThreadTarget]>;
  readonly loadNotFound$: Command<void, [string]>;
  /** Empty the pane and release the panel graph it showed. */
  readonly clear$: Command<void, []>;
  readonly onNotFoundReady$?: Command<void, [AbortSignal]>;
}

/**
 * A pane derives its panel graph from the thread it shows. The panel factory
 * runs inside the computed, so the graph is a memoized projection of pane
 * state rather than something a setup command constructs while it runs.
 */
function createChatThreadPaneSignals(
  setPane$: Command<void, [ChatThreadPaneState]>,
  onNotFoundReady$?: Command<void, [AbortSignal]>,
): ChatThreadPaneSignals {
  const internalThread$ = state<ChatThreadTarget | null>(null);
  const panel$ = computed((get): ChatPanelSignals | null => {
    const target = get(internalThread$);
    return target
      ? createChatPanelSignals(target.threadId, target.agentId, target.draft)
      : null;
  });
  const loadThread$ = command(
    ({ get, set }, target: ChatThreadTarget): ChatPanelSignals => {
      set(internalThread$, target);
      const thread = get(panel$);
      if (!thread) {
        throw new Error("chat pane did not derive its panel");
      }
      set(setPane$, { kind: "thread", thread });
      return thread;
    },
  );
  const loadNotFound$ = command(({ set }, threadId: string): void => {
    set(internalThread$, null);
    set(setPane$, { kind: "not-found", threadId });
  });
  const clear$ = command(({ set }): void => {
    set(internalThread$, null);
    set(setPane$, null);
  });
  return {
    loadThread$,
    loadNotFound$,
    clear$,
    ...(onNotFoundReady$ === undefined ? {} : { onNotFoundReady$ }),
  };
}

const leftPane = createChatThreadPaneSignals(
  setCurrentLeftPane$,
  hideAppSkeleton$,
);
const rightPane = createChatThreadPaneSignals(setCurrentRightPane$);

// Thread-owned sidebars are anchored to the previous thread's messages.
const closeThreadSidebars$ = command(({ get, set }) => {
  for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
    if (thread) {
      set(thread.sidebar.close$);
    }
  }
});

export const unloadRightThread$ = command(({ get, set }) => {
  const currentRightThread = get(currentRightThread$);
  if (currentRightThread) {
    set(currentRightThread.resetRenderedChatGroupsIfAtBottom$);
    set(currentRightThread.sidebar.close$);
  }
  set(rightPane.clear$);
  const next = new URLSearchParams(get(searchParams$));
  if (!next.has(SIDEBAR_PARAM)) {
    return;
  }
  const mainThreadId = get(currentChatThreadId$);
  if (!mainThreadId) {
    return;
  }
  next.delete(SIDEBAR_PARAM);
  // Closing navigates, the mirror of loadRightThread$. The route reload is
  // what ends this pane's setup, so no pane-local cancellation is needed.
  set(detachedNavigateTo$, ROUTES.chat, {
    pathParams: { threadId: mainThreadId },
    searchParams: next,
  });
});

const resolvePaneThread$ = command(
  async (
    { set },
    args: {
      thread: ChatPanelSignals;
      initialEventId: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { thread, initialEventId } = args;

    L.debug("resolvePaneThread$ Promise.all start", {
      threadId: thread.threadId,
    });
    await Promise.all([
      set(thread.composer.draft.load$, signal),
      set(thread.subscribeChatThread$, signal),
      initialEventId
        ? set(
            thread.scrollToEvent$,
            initialEventId,
            {
              behavior: "instant",
              viewportOffsetTop: 0,
              preloadPreviousRenderWindow: false,
            },
            signal,
          )
        : Promise.resolve(),
    ]);
    signal.throwIfAborted();
    L.debug("resolvePaneThread$ Promise.all done", {
      threadId: thread.threadId,
    });
  },
);

// Every path that ends a pane setup goes through the router, so the route
// signal is the pane's setup lifetime.
const beginPaneSetup$ = command(
  (
    { get, set },
    pane: ChatThreadPaneSignals,
    routeSignal: AbortSignal,
  ): AbortSignal => {
    routeSignal.addEventListener(
      "abort",
      () => {
        // A non-chat page must never inherit this pane on re-entry.
        // Chat-to-chat setup keeps the reference so the outer thread section
        // can preserve its established DOM identity until replacement.
        if (get(activeRoute$) !== "chat") {
          set(pane.clear$);
        }
      },
      { once: true },
    );
    return routeSignal;
  },
);

const setupPaneThread$ = command(
  async (
    { set },
    pane: ChatThreadPaneSignals,
    meta: ThreadMeta,
    initialEventId: string | null,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(beginPaneSetup$, pane, parentSignal);
    const threadId = meta.id;

    L.debug("setupPaneThread$ start", { threadId });
    const thread = set(pane.loadThread$, {
      threadId,
      agentId: meta.agentId,
      draft: set(ensureDraft$, threadId),
    });

    await set(
      resolvePaneThread$,
      {
        thread,
        initialEventId,
      },
      signal,
    );
  },
);

const setupPaneNotFound$ = command(
  (
    { set },
    pane: ChatThreadPaneSignals,
    threadId: string,
    parentSignal: AbortSignal,
  ): void => {
    const signal = set(beginPaneSetup$, pane, parentSignal);
    set(pane.loadNotFound$, threadId);
    if (pane.onNotFoundReady$) {
      set(pane.onNotFoundReady$, signal);
    }
  },
);

export const setupLeftThread$ = command(
  async (
    { set },
    meta: ThreadMeta,
    initialEventId: string | null,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    await Promise.all([
      set(syncPrimaryThread$, meta, parentSignal),
      set(setupPaneThread$, leftPane, meta, initialEventId, parentSignal),
    ]);
  },
);

export const setupLeftThreadNotFound$ = command(
  async (
    { set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    set(syncMissingPrimaryThread$);
    await set(setupPaneNotFound$, leftPane, threadId, parentSignal);
  },
);

export const setupRightThread$ = command(
  async (
    { set },
    meta: ThreadMeta,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    await set(setupPaneThread$, rightPane, meta, null, parentSignal);
  },
);

export const setupRightThreadNotFound$ = command(
  async (
    { set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    await set(setupPaneNotFound$, rightPane, threadId, parentSignal);
  },
);

export const loadLeftThread$ = command(
  ({ get, set }, threadId: string): void => {
    if (get(currentChatThreadId$) === threadId) {
      return;
    }

    // Drop sidebar state before switching threads because its content is
    // anchored to the previous thread's messages.
    set(closeThreadSidebars$);

    const next = new URLSearchParams(get(searchParams$));
    if (next.get(SIDEBAR_PARAM) === threadId) {
      next.delete(SIDEBAR_PARAM);
    }
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId },
      searchParams: next,
    });
  },
);

export const loadRightThread$ = command(
  ({ get, set }, threadId: string): void => {
    const mainThreadId = get(currentChatThreadId$);
    if (!mainThreadId || mainThreadId === threadId) {
      return;
    }

    if (get(currentRightThread$)?.threadId === threadId) {
      return;
    }

    const currentRightThread = get(currentRightThread$);
    if (currentRightThread && currentRightThread.threadId !== threadId) {
      set(currentRightThread.resetRenderedChatGroupsIfAtBottom$);
    }

    set(closeThreadSidebars$);

    const next = new URLSearchParams(get(searchParams$));
    next.set(SIDEBAR_PARAM, threadId);
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId: mainThreadId },
      searchParams: next,
    });
  },
);
