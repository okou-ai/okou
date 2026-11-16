import { command, computed, state, type Command, type Computed } from "ccstate";
import { animationFrame } from "signal-timers";
import { flushSync } from "react-dom";
import { onRef } from "../utils.ts";
import {
  CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  type ChatThreadVirtualListScrollAlign,
} from "../okou-page/sidebar-state.ts";
import {
  currentChatThreadList$,
  unreadChatThreadListSignals$,
  type ChatThreadListSignals,
} from "../agent-chat.ts";
import {
  listedThreadIds,
  threadRowKey,
  type ChatThreadListRow,
  type ThreadChatThreadListRow,
} from "./chat-thread-list-rows.ts";
import {
  sidebarChatThreadItemSignalsRegistry$,
  type SidebarChatThreadItemSignals,
} from "./sidebar-chat-thread-item.ts";
import { chatThreadOnlyArchived$ } from "./chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "./chat-thread-only-muted.ts";
import { chatThreadOnlyUnread$ } from "./chat-thread-only-unread.ts";
import {
  createProjectFoldMotionSignals,
  type ProjectFoldMotion,
} from "./project-fold-motion.ts";

const CHAT_THREAD_VIRTUAL_FALLBACK_WINDOW_SIZE = 100;
const CHAT_THREAD_VIRTUAL_OVERSCAN = 8;

export type SidebarChatThreadRow =
  | Exclude<ChatThreadListRow, ThreadChatThreadListRow>
  | (ThreadChatThreadListRow & {
      readonly signals: SidebarChatThreadItemSignals;
    });

export interface SidebarChatThreadWindow {
  readonly startIndex: number;
  readonly rows: readonly SidebarChatThreadRow[];
  readonly showAllChatsRow: boolean;
  /** Sparse retained rows keep their expanded-list indices during a fold. */
  readonly indexes?: readonly number[];
  readonly motion?: ProjectFoldMotion;
}

export interface SidebarChatThreadListSignals {
  readonly count$: Computed<number>;
  readonly rowCount$: Computed<number>;
  readonly rows$: Computed<readonly SidebarChatThreadRow[]>;
  readonly currentThreadListed$: Computed<boolean>;
  readonly hasHiddenArchivedThreads$: Computed<boolean>;
  readonly window$: Computed<SidebarChatThreadWindow>;
  readonly motionHostRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

interface SidebarChatThreadScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
}

export interface ScrollToRowRequest {
  /** The row key of a Project or chat in the list. */
  readonly key: string;
  readonly align?: ChatThreadVirtualListScrollAlign;
}

export interface SidebarChatThreadScrollSignals {
  readonly isScrolled$: Computed<boolean>;
  readonly list$: Computed<Promise<SidebarChatThreadListSignals>>;
  /** Returns false when this viewport is not mounted/visible. */
  readonly cancelProjectFold$: Command<void, []>;
  readonly foldProject$: Command<
    Promise<void> | false,
    [string, boolean, AbortSignal]
  >;
  readonly setScrollMetrics$: Command<void, [SidebarChatThreadScrollMetrics]>;
  readonly setScrollViewport$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  /** Reads the mounted viewport's height; does nothing while unmounted. */
  readonly measureViewport$: Command<void, []>;
  readonly scrollToRow$: Command<
    Promise<boolean>,
    [ScrollToRowRequest, AbortSignal]
  >;
  readonly scrollCurrentChatThreadOnRef$: Command<
    (() => void) | undefined,
    [HTMLSpanElement | null]
  >;
}

function emptyScrollMetrics(): SidebarChatThreadScrollMetrics {
  return { scrollTop: 0, clientHeight: 0 };
}

// Each viewport reads its height only when something that can change it has
// happened: its own mount, a browser resize, or refreshChatListLayout$ from
// the operation that changed the space around it.
function createSidebarChatThreadDomSignals(restoreScrollPosition: boolean) {
  const internalViewport$ = state<HTMLElement | null>(null);
  const resizeScheduled$ = state(false);
  const internalScrollMetrics$ =
    state<SidebarChatThreadScrollMetrics>(emptyScrollMetrics());

  const scrollViewport$ = computed((get) => {
    return get(internalViewport$);
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
  const scheduleViewportMeasurement$ = command(
    ({ get, set }, viewport: HTMLElement, signal: AbortSignal) => {
      if (get(resizeScheduled$)) {
        return;
      }
      set(resizeScheduled$, true);
      // Coalesce a burst of browser resize events into one read of the
      // latest layout in this frame.
      animationFrame(
        () => {
          set(resizeScheduled$, false);
          set(measureScrollViewport$, viewport);
        },
        { signal },
      );
    },
  );
  const measureViewport$ = command(({ get, set }) => {
    const viewport = get(internalViewport$);
    if (viewport) {
      set(measureScrollViewport$, viewport);
    }
  });
  const clearScrollViewport$ = command(
    ({ get, set }, viewport: HTMLElement) => {
      if (get(internalViewport$) !== viewport) {
        return;
      }
      set(internalViewport$, null);
      set(resizeScheduled$, false);
      if (!restoreScrollPosition) {
        set(internalScrollMetrics$, emptyScrollMetrics());
      }
    },
  );
  const setScrollViewport$ = onRef(
    command(({ get, set }, viewport: HTMLElement, signal: AbortSignal) => {
      if (restoreScrollPosition) {
        viewport.scrollTop = get(internalScrollMetrics$).scrollTop;
      }
      set(internalViewport$, viewport);
      set(resizeScheduled$, false);
      set(measureScrollViewport$, viewport);
      window.addEventListener(
        "resize",
        () => {
          set(scheduleViewportMeasurement$, viewport, signal);
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
    measureViewport$,
  };
}

type SidebarChatThreadDomSignals = ReturnType<
  typeof createSidebarChatThreadDomSignals
>;

function getFixedVirtualRange({
  itemCount,
  scrollTop,
  viewportHeight,
  rowHeight,
}: {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
}) {
  const requestedFirstVisibleIndex = Math.floor(
    Math.max(0, scrollTop) / rowHeight,
  );
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
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

function attachItemSignals(
  rows: readonly ChatThreadListRow[],
  items: readonly SidebarChatThreadItemSignals[],
): readonly SidebarChatThreadRow[] {
  let itemIndex = 0;
  return rows.map((row): SidebarChatThreadRow => {
    if (row.kind !== "thread") {
      return row;
    }
    const signals = items[itemIndex];
    itemIndex += 1;
    if (signals?.threadId !== row.threadId) {
      throw new Error("Chat rows and their item signals diverged");
    }
    return { ...row, signals };
  });
}

// The sidebar's unread list is short and renders every row, so it skips the
// virtual window and keeps its own loading state.
export const unreadSidebarChatThreadRows$ = computed(async (get) => {
  const list = await get(unreadChatThreadListSignals$);
  return attachItemSignals(
    get(list.rows$),
    get(sidebarChatThreadItemSignalsRegistry$).reconcile(
      listedThreadIds(get(list.rows$)),
    ),
  );
});

function createSidebarChatThreadViewportSignals(
  domSignals: SidebarChatThreadDomSignals,
  list: ChatThreadListSignals,
  showAllChatsRow: boolean,
  rowHeight: number,
  foldMotion: ReturnType<typeof createProjectFoldMotionSignals>,
): SidebarChatThreadListSignals {
  const rows$ = computed((get): readonly SidebarChatThreadRow[] => {
    return attachItemSignals(
      get(list.rows$),
      get(sidebarChatThreadItemSignalsRegistry$).reconcile(
        listedThreadIds(get(list.rows$)),
      ),
    );
  });
  const rowCount$ = computed((get) => {
    return get(list.count$) + (showAllChatsRow ? 1 : 0);
  });
  const window$ = computed((get): SidebarChatThreadWindow => {
    const rows = get(rows$);
    const rowCount = get(rowCount$);
    // The window follows the recorded metrics only; every change to them is
    // written by a scroll, a resize or a layout refresh.
    const { scrollTop, clientHeight: measuredViewportHeight } = get(
      domSignals.scrollMetrics$,
    );
    const viewportHeight =
      measuredViewportHeight || CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT;
    const motion = get(foldMotion.motion$);
    if (motion?.logicalRows === rows) {
      const { geometry, range, expandedRows } = motion;
      const { blockStartIndex, childCount } = geometry;
      const indexes = [
        ...Array.from(
          { length: blockStartIndex - range.startIndex },
          (_, index) => {
            return range.startIndex + index;
          },
        ),
        ...Array.from(
          { length: range.childEnd - range.childStart },
          (_, index) => {
            return blockStartIndex + range.childStart + index;
          },
        ),
        ...Array.from(
          { length: range.suffixEnd - range.suffixStart },
          (_, index) => {
            return blockStartIndex + childCount + range.suffixStart + index;
          },
        ),
      ];
      const logicalHeader = rows.find((row) => {
        return row.kind === "project" && row.project.id === motion.projectId;
      });
      const visibleIndexes = indexes.filter((index) => {
        return index < expandedRows.length;
      });
      return {
        startIndex: range.startIndex,
        rows: visibleIndexes.map((index) => {
          const row = expandedRows[index];
          if (!row) {
            throw new Error("Project fold range exceeds expanded rows");
          }
          return row.kind === "project" &&
            row.project.id === motion.projectId &&
            logicalHeader
            ? logicalHeader
            : row;
        }),
        indexes: visibleIndexes,
        showAllChatsRow:
          showAllChatsRow && indexes.includes(expandedRows.length),
        motion,
      };
    }
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

    return {
      startIndex,
      rows: rows.slice(startIndex, Math.min(resolvedEndIndex, rows.length)),
      showAllChatsRow:
        showAllChatsRow &&
        startIndex <= rows.length &&
        resolvedEndIndex > rows.length,
    };
  });

  const motionHostRef$ = command(({ set }, host: HTMLElement | null) => {
    if (!host) {
      return;
    }
    set(foldMotion.bindList$, rows$, showAllChatsRow);
    return set(foldMotion.hostRef$, host);
  });
  return {
    count$: list.count$,
    rowCount$,
    rows$,
    currentThreadListed$: list.currentThreadListed$,
    hasHiddenArchivedThreads$: list.hasHiddenArchivedThreads$,
    window$,
    motionHostRef$,
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
  source$ = currentChatThreadList$,
  rowHeight = CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  restoreScrollPosition = false,
}: {
  source$?: Computed<Promise<ChatThreadListSignals>>;
  rowHeight?: number;
  restoreScrollPosition?: boolean;
} = {}): SidebarChatThreadScrollSignals {
  const domSignals = createSidebarChatThreadDomSignals(restoreScrollPosition);
  const foldMotion = createProjectFoldMotionSignals(domSignals, rowHeight);
  // The async boundary selects the shared list context. Each viewport only
  // adds its own synchronous virtual window over that list.
  const list$ = computed(async (get): Promise<SidebarChatThreadListSignals> => {
    const showAllChatsRow =
      get(chatThreadOnlyUnread$) ||
      get(chatThreadOnlyArchived$) ||
      get(chatThreadOnlyMuted$);
    const list = await get(source$);
    return createSidebarChatThreadViewportSignals(
      domSignals,
      list,
      showAllChatsRow,
      rowHeight,
      foldMotion,
    );
  });
  const scrollListToIndex$ = createScrollListToIndexCommand(
    domSignals,
    rowHeight,
  );
  const scrollToRow$ = command(
    async ({ get, set }, request: ScrollToRowRequest, signal: AbortSignal) => {
      const { key, align = "top" } = request;
      const list = await get(list$);
      signal.throwIfAborted();
      if (get(foldMotion.motion$)) {
        flushSync(() => {
          set(foldMotion.cancel$);
        });
      }

      const index = get(list.rows$).findIndex((row) => {
        return row.key === key;
      });
      if (index === -1) {
        return false;
      }

      return set(scrollListToIndex$, index, align);
    },
  );
  const scrollCurrentChatThreadOnRef$ = onRef(
    command(
      async ({ get, set }, element: HTMLSpanElement, signal: AbortSignal) => {
        const threadId = element.dataset.chatThreadId;
        if (!threadId) {
          return;
        }
        const motion = get(foldMotion.motion$);
        const mountedList = get(foldMotion.list$);
        if (
          motion &&
          mountedList &&
          get(mountedList.rows$) === motion.logicalRows
        ) {
          const index = motion.logicalRows.findIndex((row) => {
            return row.kind === "thread" && row.threadId === threadId;
          });
          const { scrollTop, clientHeight } = get(domSignals.scrollMetrics$);
          // Expanding can mount this existing marker. Its already-visible target
          // needs no scroll and must not cancel the command that revealed it.
          if (
            index !== -1 &&
            index * rowHeight >= scrollTop &&
            (index + 1) * rowHeight <= scrollTop + clientHeight
          ) {
            return;
          }
        }
        await set(
          scrollToRow$,
          { key: threadRowKey(threadId), align: "top" },
          signal,
        );
      },
    ),
  );

  const setScrollMetrics$ = command(
    ({ set }, metrics: SidebarChatThreadScrollMetrics) => {
      set(foldMotion.cancel$);
      set(domSignals.setScrollMetrics$, metrics);
    },
  );
  const measureViewport$ = command(({ set }) => {
    set(foldMotion.cancel$);
    set(domSignals.measureViewport$);
  });
  const foldProject$ = command(
    (
      { get, set },
      projectId: string,
      expanded: boolean,
      signal: AbortSignal,
    ) => {
      const viewport = get(domSignals.scrollViewport$);
      const list = get(foldMotion.list$);
      if (!viewport?.isConnected || viewport.clientHeight <= 0 || !list) {
        return false;
      }
      return set(
        foldMotion.fold$,
        {
          rows$: list.rows$,
          trailingRow: list.trailingRow,
          projectId,
          expanded,
        },
        signal,
      );
    },
  );
  return {
    isScrolled$: domSignals.isScrolled$,
    list$,
    foldProject$,
    cancelProjectFold$: foldMotion.cancel$,
    setScrollMetrics$,
    setScrollViewport$: domSignals.setScrollViewport$,
    measureViewport$,
    scrollToRow$,
    scrollCurrentChatThreadOnRef$,
  };
}

export const threeColumnSidebarChatThreadScrollSignals =
  createSidebarChatThreadScrollSignals();

export const scrollToChatListRow$ = command(
  async (
    { set },
    request: ScrollToRowRequest,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const scrolled = await set(
      threeColumnSidebarChatThreadScrollSignals.scrollToRow$,
      request,
      signal,
    );
    signal.throwIfAborted();
    return scrolled;
  },
);
