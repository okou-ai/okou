import { command, computed, state, type Command, type Computed } from "ccstate";
import { animationFrame } from "signal-timers";
import { onRef } from "../utils.ts";
import {
  CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  type ChatThreadVirtualListScrollAlign,
} from "../okou-page/sidebar-state.ts";
import {
  currentChatThreadListSignals$,
  type ChatThreadListSignals,
} from "../agent-chat.ts";
import {
  sidebarChatThreadItemSignalsRegistry$,
  type SidebarChatThreadItemSignals,
} from "./sidebar-chat-thread-item.ts";

const CHAT_THREAD_VIRTUAL_OVERSCAN = 8;
const CHAT_THREAD_VIRTUAL_FALLBACK_WINDOW_SIZE = 100;

export interface SidebarChatThreadWindow {
  readonly startIndex: number;
  readonly items: readonly SidebarChatThreadItemSignals[];
}

export interface SidebarChatThreadListSignals {
  readonly count$: Computed<number>;
  readonly currentThreadListed$: Computed<boolean>;
  readonly hasHiddenArchivedThreads$: Computed<boolean>;
  readonly threadIds$: Computed<readonly string[]>;
  readonly window$: Computed<SidebarChatThreadWindow>;
}

interface SidebarChatThreadScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
}

export interface ScrollToThreadRequest {
  readonly threadId: string;
  readonly align?: ChatThreadVirtualListScrollAlign;
}

export interface SidebarChatThreadScrollSignals {
  readonly isScrolled$: Computed<boolean>;
  readonly list$: Computed<Promise<SidebarChatThreadListSignals>>;
  readonly setScrollMetrics$: Command<void, [SidebarChatThreadScrollMetrics]>;
  readonly refreshScrollViewport$: Command<void, []>;
  readonly setScrollViewport$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly scrollToThread$: Command<
    Promise<boolean>,
    [string | ScrollToThreadRequest, AbortSignal]
  >;
  readonly scrollCurrentChatThreadOnRef$: Command<
    (() => void) | undefined,
    [HTMLSpanElement | null]
  >;
}

function emptyScrollMetrics(): SidebarChatThreadScrollMetrics {
  return {
    scrollTop: 0,
    clientHeight: 0,
  };
}

function createSidebarChatThreadDomSignals() {
  const internalViewportRuntime$ = state<{
    readonly element: HTMLElement;
    readonly signal: AbortSignal;
    resizeScheduled: boolean;
  } | null>(null);
  const internalScrollMetrics$ =
    state<SidebarChatThreadScrollMetrics>(emptyScrollMetrics());

  const scrollViewport$ = computed((get) => {
    return get(internalViewportRuntime$)?.element ?? null;
  });
  const scrollMetrics$ = computed((get) => {
    return get(internalScrollMetrics$);
  });
  const isScrolled$ = computed((get) => {
    return get(internalScrollMetrics$).scrollTop > 0;
  });

  const measureScrollViewport$ = command(
    ({ get, set }, viewport: HTMLElement) => {
      const metrics = {
        scrollTop: viewport.scrollTop,
        clientHeight: viewport.clientHeight,
      };
      const previous = get(internalScrollMetrics$);
      if (
        previous.scrollTop === metrics.scrollTop &&
        previous.clientHeight === metrics.clientHeight
      ) {
        return;
      }
      set(internalScrollMetrics$, metrics);
    },
  );
  const refreshScrollViewport$ = command(({ get, set }) => {
    const runtime = get(internalViewportRuntime$);
    if (!runtime || runtime.resizeScheduled) {
      return;
    }
    runtime.resizeScheduled = true;
    // Layout refs and window resize events share one pending measurement.
    // Read after the DOM commit, using the latest layout in this frame.
    animationFrame(
      () => {
        runtime.resizeScheduled = false;
        set(measureScrollViewport$, runtime.element);
      },
      { signal: runtime.signal },
    );
  });
  const clearScrollViewport$ = command(
    ({ get, set }, viewport: HTMLElement) => {
      if (get(internalViewportRuntime$)?.element !== viewport) {
        return;
      }
      set(internalViewportRuntime$, null);
      set(internalScrollMetrics$, emptyScrollMetrics());
    },
  );
  const setScrollViewport$ = onRef(
    command(({ set }, viewport: HTMLElement, signal: AbortSignal) => {
      set(internalViewportRuntime$, {
        element: viewport,
        signal,
        resizeScheduled: false,
      });
      set(measureScrollViewport$, viewport);
      window.addEventListener(
        "resize",
        () => {
          set(refreshScrollViewport$);
        },
        { signal },
      );
      signal.addEventListener(
        "abort",
        () => {
          set(clearScrollViewport$, viewport);
        },
        { once: true },
      );
    }),
  );
  const setScrollMetrics$ = command(
    ({ set }, metrics: SidebarChatThreadScrollMetrics) => {
      set(internalScrollMetrics$, metrics);
    },
  );

  return {
    isScrolled$,
    scrollViewport$,
    scrollMetrics$,
    setScrollViewport$,
    setScrollMetrics$,
    refreshScrollViewport$,
  };
}

type SidebarChatThreadDomSignals = ReturnType<
  typeof createSidebarChatThreadDomSignals
>;

function getFixedVirtualRange({
  itemCount,
  scrollTop,
  viewportHeight,
}: {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
}) {
  const requestedFirstVisibleIndex = Math.floor(
    Math.max(0, scrollTop) / CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  );
  const visibleCount = Math.max(
    1,
    Math.ceil(viewportHeight / CHAT_THREAD_VIRTUAL_ROW_HEIGHT),
  );
  const firstVisibleIndex = Math.min(
    requestedFirstVisibleIndex,
    Math.max(0, itemCount - visibleCount),
  );
  const startIndex = Math.max(
    0,
    firstVisibleIndex - CHAT_THREAD_VIRTUAL_OVERSCAN,
  );
  const endIndex = Math.min(
    itemCount,
    firstVisibleIndex + visibleCount + CHAT_THREAD_VIRTUAL_OVERSCAN,
  );

  return { startIndex, endIndex };
}

function createSidebarChatThreadViewportSignals(
  domSignals: SidebarChatThreadDomSignals,
  list: ChatThreadListSignals,
): SidebarChatThreadListSignals {
  const itemSignals$ = computed((get) => {
    return get(sidebarChatThreadItemSignalsRegistry$).reconcile(
      get(list.threadIds$),
    );
  });
  const window$ = computed((get): SidebarChatThreadWindow => {
    const itemSignals = get(itemSignals$);
    const scrollViewport = get(domSignals.scrollViewport$);
    const scrollMetrics = get(domSignals.scrollMetrics$);
    const measuredViewportHeight =
      scrollMetrics.clientHeight || scrollViewport?.clientHeight;
    const viewportHeight =
      measuredViewportHeight || CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT;
    const scrollTop = scrollViewport?.scrollTop ?? scrollMetrics.scrollTop;
    const { startIndex, endIndex } = getFixedVirtualRange({
      itemCount: itemSignals.length,
      scrollTop,
      viewportHeight,
    });
    const resolvedEndIndex = measuredViewportHeight
      ? endIndex
      : Math.min(
          itemSignals.length,
          Math.max(
            endIndex,
            startIndex + CHAT_THREAD_VIRTUAL_FALLBACK_WINDOW_SIZE,
          ),
        );

    return {
      startIndex,
      items: itemSignals.slice(startIndex, resolvedEndIndex),
    };
  });

  return {
    count$: list.count$,
    currentThreadListed$: list.currentThreadListed$,
    hasHiddenArchivedThreads$: list.hasHiddenArchivedThreads$,
    threadIds$: list.threadIds$,
    window$,
  };
}

function createScrollVirtualListToIndexCommand(
  domSignals: SidebarChatThreadDomSignals,
) {
  return command(
    (
      { get, set },
      index: number,
      align: ChatThreadVirtualListScrollAlign = "top",
    ): boolean => {
      if (!Number.isInteger(index) || index < 0) {
        return false;
      }

      const scrollViewport = get(domSignals.scrollViewport$);
      if (!scrollViewport) {
        return false;
      }

      const currentMetrics = get(domSignals.scrollMetrics$);
      const viewportHeight =
        currentMetrics.clientHeight ||
        scrollViewport.clientHeight ||
        CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT;
      const rowTop = index * CHAT_THREAD_VIRTUAL_ROW_HEIGHT;
      const rowBottom = rowTop + CHAT_THREAD_VIRTUAL_ROW_HEIGHT;
      const viewportTop = scrollViewport.scrollTop;
      const viewportBottom = viewportTop + viewportHeight;
      let nextScrollTop = viewportTop;
      if (rowBottom > viewportBottom) {
        nextScrollTop =
          align === "bottom"
            ? Math.max(0, rowBottom - viewportHeight)
            : Math.max(0, rowTop);
      } else if (rowTop < viewportTop) {
        nextScrollTop = Math.max(0, rowTop);
      }

      scrollViewport.scrollTop = nextScrollTop;
      set(domSignals.setScrollMetrics$, {
        scrollTop: nextScrollTop,
        clientHeight: scrollViewport.clientHeight,
      });
      return true;
    },
  );
}

function createSidebarChatThreadScrollSignals(): SidebarChatThreadScrollSignals {
  const domSignals = createSidebarChatThreadDomSignals();
  // The async boundary selects the shared list context. Each viewport only
  // adds its own synchronous virtual window over that list.
  const list$ = computed(async (get): Promise<SidebarChatThreadListSignals> => {
    const list = await get(currentChatThreadListSignals$);
    return createSidebarChatThreadViewportSignals(domSignals, list);
  });
  const scrollVirtualListToIndex$ =
    createScrollVirtualListToIndexCommand(domSignals);
  const scrollToThread$ = command(
    async (
      { get, set },
      request: string | ScrollToThreadRequest,
      signal: AbortSignal,
    ) => {
      const threadId = typeof request === "string" ? request : request.threadId;
      const align = typeof request === "string" ? "top" : request.align;
      const list = await get(list$);
      signal.throwIfAborted();

      const index = get(list.threadIds$).indexOf(threadId);
      if (index === -1) {
        return false;
      }

      return set(scrollVirtualListToIndex$, index, align);
    },
  );
  const scrollCurrentChatThreadOnRef$ = onRef(
    command(async ({ set }, element: HTMLSpanElement, signal: AbortSignal) => {
      const threadId = element.dataset.chatThreadId;
      if (!threadId) {
        return;
      }
      await set(scrollToThread$, { threadId, align: "top" }, signal);
    }),
  );

  return {
    isScrolled$: domSignals.isScrolled$,
    list$,
    setScrollMetrics$: domSignals.setScrollMetrics$,
    setScrollViewport$: domSignals.setScrollViewport$,
    refreshScrollViewport$: domSignals.refreshScrollViewport$,
    scrollToThread$,
    scrollCurrentChatThreadOnRef$,
  };
}

export const responsiveSidebarChatThreadScrollSignals =
  createSidebarChatThreadScrollSignals();
export const threeColumnSidebarChatThreadScrollSignals =
  createSidebarChatThreadScrollSignals();

const refreshSidebarChatThreadLayout$ = command(({ set }) => {
  set(responsiveSidebarChatThreadScrollSignals.refreshScrollViewport$);
  set(threeColumnSidebarChatThreadScrollSignals.refreshScrollViewport$);
});

// Pinned entries and upgrade cards consume space beside the chat viewport.
// Their committed insertion/removal, including async data updates, determines
// when the remaining height needs to be measured again.
export const refreshSidebarChatThreadLayoutOnRef$ = onRef(
  command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
    set(refreshSidebarChatThreadLayout$);
    signal.addEventListener(
      "abort",
      () => {
        set(refreshSidebarChatThreadLayout$);
      },
      { once: true },
    );
  }),
);

export const scrollToThread$ = command(
  async (
    { set },
    request: string | ScrollToThreadRequest,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const responsiveScroll = set(
      responsiveSidebarChatThreadScrollSignals.scrollToThread$,
      request,
      signal,
    );
    const threeColumnScroll = set(
      threeColumnSidebarChatThreadScrollSignals.scrollToThread$,
      request,
      signal,
    );
    const [responsiveScrolled, threeColumnScrolled] = await Promise.all([
      responsiveScroll,
      threeColumnScroll,
    ]);
    signal.throwIfAborted();
    return responsiveScrolled || threeColumnScrolled;
  },
);
