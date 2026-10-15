import { command, computed, type Command, type Computed } from "ccstate";
import { onRef } from "../utils.ts";
import {
  createFixedVirtualScrollSignals as createSidebarChatThreadDomSignals,
  getFixedVirtualRange,
} from "../fixed-virtual-list.ts";
import {
  CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  type ChatThreadVirtualListScrollAlign,
} from "../okou-page/sidebar-state.ts";
import {
  currentChatThreadListIds$,
  currentChatThreadListSignals$,
  unreadChatThreads$,
  type ChatThreadListSignals,
} from "../agent-chat.ts";
import {
  sidebarChatThreadItemSignalsRegistry$,
  type SidebarChatThreadItemSignals,
} from "./sidebar-chat-thread-item.ts";
import { chatThreadOnlyArchived$ } from "./chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "./chat-thread-only-muted.ts";

const CHAT_THREAD_VIRTUAL_FALLBACK_WINDOW_SIZE = 100;

export const unreadSidebarChatThreadList$ = computed(async (get) => {
  const threads = await get(unreadChatThreads$);
  const threadIds = threads.map((thread) => {
    return thread.id;
  });
  return {
    items: get(sidebarChatThreadItemSignalsRegistry$).reconcile(threadIds),
  };
});

export interface SidebarChatThreadWindow {
  readonly startIndex: number;
  readonly items: readonly SidebarChatThreadItemSignals[];
  readonly showAllChatsRow: boolean;
}

export interface SidebarChatThreadListSignals {
  readonly count$: Computed<number>;
  readonly rowCount$: Computed<number>;
  readonly currentThreadListed$: Computed<boolean>;
  readonly hasHiddenArchivedThreads$: Computed<boolean>;
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

type SidebarChatThreadDomSignals = ReturnType<
  typeof createSidebarChatThreadDomSignals
>;

function createSidebarChatThreadViewportSignals(
  domSignals: SidebarChatThreadDomSignals,
  list: ChatThreadListSignals,
  showAllChatsRow: boolean,
  rowHeight: number,
): SidebarChatThreadListSignals {
  const itemSignals$ = computed((get) => {
    return get(sidebarChatThreadItemSignalsRegistry$).reconcile(
      get(list.threadIds$),
    );
  });
  const rowCount$ = computed((get) => {
    return get(itemSignals$).length + (showAllChatsRow ? 1 : 0);
  });
  const window$ = computed((get): SidebarChatThreadWindow => {
    const itemSignals = get(itemSignals$);
    const rowCount = get(rowCount$);
    const scrollViewport = get(domSignals.scrollViewport$);
    const scrollMetrics = get(domSignals.scrollMetrics$);
    const measuredViewportHeight =
      scrollMetrics.clientHeight || scrollViewport?.clientHeight;
    const viewportHeight =
      measuredViewportHeight || CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT;
    const scrollTop = scrollViewport?.scrollTop ?? scrollMetrics.scrollTop;
    const { startIndex, endIndex } = getFixedVirtualRange({
      itemCount: rowCount,
      scrollTop,
      viewportHeight,
      rowHeight,
    });
    const resolvedEndIndex = measuredViewportHeight
      ? endIndex
      : Math.min(
          rowCount,
          Math.max(
            endIndex,
            startIndex + CHAT_THREAD_VIRTUAL_FALLBACK_WINDOW_SIZE,
          ),
        );
    const threadCount = itemSignals.length;

    return {
      startIndex,
      items: itemSignals.slice(
        startIndex,
        Math.min(resolvedEndIndex, threadCount),
      ),
      showAllChatsRow:
        showAllChatsRow &&
        startIndex <= threadCount &&
        resolvedEndIndex > threadCount,
    };
  });

  return {
    count$: list.count$,
    rowCount$,
    currentThreadListed$: list.currentThreadListed$,
    hasHiddenArchivedThreads$: list.hasHiddenArchivedThreads$,
    window$,
  };
}

function createScrollListToIndexCommand(
  domSignals: SidebarChatThreadDomSignals,
  rowHeight: number,
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
      const rowTop = index * rowHeight;
      const rowBottom = rowTop + rowHeight;
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

export function createSidebarChatThreadScrollSignals({
  source$ = currentChatThreadListSignals$,
  rowHeight = CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  restoreScrollPosition = false,
}: {
  source$?: Computed<Promise<ChatThreadListSignals>>;
  rowHeight?: number;
  restoreScrollPosition?: boolean;
} = {}): SidebarChatThreadScrollSignals {
  const domSignals = createSidebarChatThreadDomSignals(restoreScrollPosition);
  // The async boundary selects the shared list context. Each viewport only
  // adds its own synchronous virtual window over that list.
  const list$ = computed(async (get): Promise<SidebarChatThreadListSignals> => {
    const showAllChatsRow =
      get(chatThreadOnlyArchived$) || get(chatThreadOnlyMuted$);
    const list = await get(source$);
    return createSidebarChatThreadViewportSignals(
      domSignals,
      list,
      showAllChatsRow,
      rowHeight,
    );
  });
  const scrollListToIndex$ = createScrollListToIndexCommand(
    domSignals,
    rowHeight,
  );
  const scrollToThread$ = command(
    async (
      { get, set },
      request: string | ScrollToThreadRequest,
      signal: AbortSignal,
    ) => {
      const threadId = typeof request === "string" ? request : request.threadId;
      const align = typeof request === "string" ? "top" : request.align;
      const threadIds = await get(currentChatThreadListIds$);
      signal.throwIfAborted();

      const index = threadIds.indexOf(threadId);
      if (index === -1) {
        return false;
      }

      return set(scrollListToIndex$, index, align);
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
  createSidebarChatThreadScrollSignals({ restoreScrollPosition: true });
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
