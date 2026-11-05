import { command, computed, state } from "ccstate";

import { localStorageSignals } from "../external/local-storage.ts";
import {
  CHAT_LIST_RESTORE_DISTANCE,
  CHAT_LIST_MIN_WIDTH,
  chatListWidth$,
  commitChatListWidth$,
  createResizeMask,
  resizePointerClientX,
  setLiveChatListWidth$,
  setStoredChatListHidden$,
  storedChatListHidden$,
  unifiedChatWorkspace$,
} from "../okou-page/unified-chat-workspace.ts";
import { pageSignal$ } from "../page-signal.ts";
import { isNonArrayRecord, jsonParseOr, onRef, resetSignal } from "../utils.ts";

// Smallest the sidebar may shrink to before its content stops being usable.
export const CHAT_THREAD_SIDEBAR_MIN_WIDTH = 400;
// Width the chat thread keeps so its composer never collapses.
export const CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH = 600;
// The unified workspace gives the side panel more room: a 1440px browser
// screen is scaled to the panel, so its width is what keeps pages legible.
export const UNIFIED_CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH = 420;
// Share of the space beside the chat list a panel opens at before resizing.
export const UNIFIED_CHAT_THREAD_SIDEBAR_DEFAULT_SHARE = 0.55;
// The frame margin the sheet gains when the chat list folds away.
const WORKSPACE_FRAME_GAP = 8;
const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 64;

const internalChatThreadSidebarWidth$ = state<number | null>(null);

export const chatThreadSidebarWidth$ = computed<number | null>((get) => {
  return get(internalChatThreadSidebarWidth$);
});

const setChatThreadSidebarWidth$ = command(({ set }, width: number) => {
  set(internalChatThreadSidebarWidth$, Math.round(width));
});

// Unified workspace: each panel kind keeps its own width, because a browser
// wants room while a resource list reads best narrow.
const sidebarWidthsStorage = localStorageSignals("thread-sidebar-widths");
const internalLiveSidebarWidth$ = state<{
  readonly key: string;
  readonly width: number;
} | null>(null);

function parseSidebarWidths(
  raw: string | null,
): Readonly<Record<string, number>> {
  const parsed = raw ? jsonParseOr<unknown>(raw, null) : null;
  if (!isNonArrayRecord(parsed)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, number] => {
      return typeof entry[1] === "number" && Number.isFinite(entry[1]);
    }),
  );
}

const storedSidebarWidths$ = computed((get) => {
  return parseSidebarWidths(get(sidebarWidthsStorage.get$));
});

export const unifiedChatThreadSidebarWidths$ = computed((get) => {
  const stored = get(storedSidebarWidths$);
  const live = get(internalLiveSidebarWidth$);
  return live ? { ...stored, [live.key]: live.width } : stored;
});

const writeSidebarWidth$ = command(
  ({ get, set }, key: string, width: number | null) => {
    const next: Record<string, number> = { ...get(storedSidebarWidths$) };
    if (width === null) {
      delete next[key];
    } else {
      next[key] = Math.round(width);
    }
    set(internalLiveSidebarWidth$, null);
    set(sidebarWidthsStorage.set$, JSON.stringify(next));
  },
);

const commitLiveSidebarWidth$ = command(({ get, set }) => {
  const live = get(internalLiveSidebarWidth$);
  if (live) {
    set(writeSidebarWidth$, live.key, live.width);
  }
});

interface UnifiedDragGeometry {
  readonly containerRight: number;
  readonly containerWidth: number;
  readonly listWidth: number;
  readonly listHidden: boolean;
}

interface UnifiedDragResult {
  readonly width: number;
  readonly listWidth: number;
  readonly listHidden: boolean;
  readonly atMin: boolean;
  readonly atMax: boolean;
}

/**
 * Widening the panel past the thread's minimum takes the room from the chat
 * list, then folds the list away. Every step is computed from the gesture's
 * starting geometry, so dragging back within one gesture restores the list.
 */
function unifiedDragLayout(
  geometry: UnifiedDragGeometry,
  pointerX: number,
  listFolded: boolean,
): UnifiedDragResult {
  const desired = geometry.containerRight - pointerX;
  const maxWithList =
    geometry.containerWidth - UNIFIED_CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH;
  const foldedMax = geometry.listHidden
    ? maxWithList
    : maxWithList + geometry.listWidth - WORKSPACE_FRAME_GAP;
  const result = (
    width: number,
    listWidth: number,
    listHidden: boolean,
  ): UnifiedDragResult => {
    return {
      width,
      listWidth,
      listHidden,
      atMin: width <= CHAT_THREAD_SIDEBAR_MIN_WIDTH,
      atMax: width >= foldedMax,
    };
  };
  const foldWidth = maxWithList + geometry.listWidth - CHAT_LIST_MIN_WIDTH;
  const foldThreshold =
    foldWidth - (listFolded ? CHAT_LIST_RESTORE_DISTANCE : 0);
  if (!geometry.listHidden && desired > foldThreshold) {
    return result(
      Math.max(CHAT_THREAD_SIDEBAR_MIN_WIDTH, Math.min(desired, foldedMax)),
      geometry.listWidth,
      true,
    );
  }
  if (desired <= maxWithList || geometry.listHidden) {
    return result(
      Math.max(
        CHAT_THREAD_SIDEBAR_MIN_WIDTH,
        Math.min(desired, Math.max(CHAT_THREAD_SIDEBAR_MIN_WIDTH, maxWithList)),
      ),
      geometry.listWidth,
      geometry.listHidden,
    );
  }
  return result(desired, geometry.listWidth - (desired - maxWithList), false);
}

const resizeUnifiedSidebar$ = command(
  (
    { get, set },
    key: string,
    next: UnifiedDragResult,
    initialListWidth: number,
  ) => {
    set(setStoredChatListHidden$, next.listHidden);
    set(
      setLiveChatListWidth$,
      next.listWidth === initialListWidth ? null : next.listWidth,
    );
    const width = Math.round(next.width);
    const live = get(internalLiveSidebarWidth$);
    if (!live || live.key !== key || live.width !== width) {
      set(internalLiveSidebarWidth$, { key, width });
    }
  },
);

/** Width the panel renders at before any resize, as the shell's CSS does. */
function unifiedDefaultWidth(containerWidth: number): number {
  return Math.max(
    CHAT_THREAD_SIDEBAR_MIN_WIDTH,
    Math.min(
      containerWidth * UNIFIED_CHAT_THREAD_SIDEBAR_DEFAULT_SHARE,
      containerWidth - UNIFIED_CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
    ),
  );
}

const internalChatThreadSidebarResizing$ = state(false);
export const chatThreadSidebarResizing$ = computed((get) => {
  return get(internalChatThreadSidebarResizing$);
});

const resetChatThreadSidebarResize$ = resetSignal();

const finishChatThreadSidebarResize$ = command(({ set }, unified: boolean) => {
  // The final coordinate is already live; release before persisting it.
  set(resetChatThreadSidebarResize$);
  if (unified) {
    set(commitLiveSidebarWidth$);
    set(commitChatListWidth$);
  }
});

const chatThreadSidebarDragMaskEl$ = computed(() => {
  return createResizeMask("data-chat-thread-sidebar-resize-mask", "col-resize");
});

const startChatThreadSidebarResize$ = command(
  (
    { get, set },
    container: HTMLElement,
    handle: HTMLDivElement,
    {
      pointerId,
      startX,
    }: { readonly pointerId: number; readonly startX: number },
    ownerSignal: AbortSignal,
  ): void => {
    ownerSignal.throwIfAborted();

    const rect = container.getBoundingClientRect();
    const maxWidth = Math.max(
      CHAT_THREAD_SIDEBAR_MIN_WIDTH,
      rect.width - CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
    );
    const unifiedKey = get(unifiedChatWorkspace$)
      ? (handle.dataset.widthKey ?? "")
      : null;
    const unifiedGeometry: UnifiedDragGeometry = {
      containerRight: rect.right,
      containerWidth: rect.width,
      listWidth: get(chatListWidth$),
      listHidden: get(storedChatListHidden$),
    };
    let listFolded = unifiedGeometry.listHidden;
    const handleRect = handle.getBoundingClientRect();
    // Keep the distance from the seam's centre instead of snapping a wide hit
    // target to the pointer. Non-rendered synthetic handles have no geometry.
    const grabOffset =
      unifiedKey !== null && handleRect.width > 0
        ? startX - (handleRect.left + handleRect.width / 2)
        : 0;
    const dragSignal = set(resetChatThreadSidebarResize$, ownerSignal);
    // Capture before mounting the mask so a failed capture cannot leave it
    // blocking the page. Events stay on this owner across embedded frames.
    handle.setPointerCapture(pointerId);
    const dragMaskEl = get(chatThreadSidebarDragMaskEl$);

    function resetResize(): void {
      if (!dragSignal.aborted) {
        set(finishChatThreadSidebarResize$, unifiedKey !== null);
      }
    }

    function moveResize(pointerX: number): void {
      if (dragSignal.aborted || !Number.isFinite(pointerX)) {
        return;
      }
      if (unifiedKey === null) {
        set(
          setChatThreadSidebarWidth$,
          Math.min(
            Math.max(rect.right - pointerX, CHAT_THREAD_SIDEBAR_MIN_WIDTH),
            maxWidth,
          ),
        );
        return;
      }
      const next = unifiedDragLayout(
        unifiedGeometry,
        pointerX - grabOffset,
        listFolded,
      );
      listFolded = next.listHidden;
      // At a limit the cursor points the only way the divider can still go.
      dragMaskEl.style.cursor = next.atMax
        ? "e-resize"
        : next.atMin
          ? "w-resize"
          : "col-resize";
      set(resizeUnifiedSidebar$, unifiedKey, next, unifiedGeometry.listWidth);
    }

    function endPointerResize(event: PointerEvent): void {
      if (event.pointerId !== pointerId || dragSignal.aborted) {
        return;
      }
      const pointerX =
        event.type === "pointerup" ? resizePointerClientX(event) : null;
      if (pointerX !== null) {
        moveResize(pointerX);
      }
      resetResize();
    }

    handle.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== pointerId || dragSignal.aborted) {
          return;
        }
        if (event.buttons === 0) {
          resetResize();
          return;
        }
        moveResize(event.clientX);
      },
      { signal: dragSignal },
    );
    handle.addEventListener("pointerup", endPointerResize, {
      signal: dragSignal,
    });
    handle.addEventListener("pointercancel", endPointerResize, {
      signal: dragSignal,
    });
    handle.addEventListener("lostpointercapture", endPointerResize, {
      signal: dragSignal,
    });
    window.addEventListener("blur", resetResize, { signal: dragSignal });

    dragSignal.addEventListener(
      "abort",
      () => {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        dragMaskEl.remove();
        dragMaskEl.style.cursor = "col-resize";
        set(internalChatThreadSidebarResizing$, false);
      },
      { once: true },
    );

    document.body.append(dragMaskEl);
    set(internalChatThreadSidebarResizing$, true);
  },
);

export const chatThreadSidebarResizeHandleRef$ = onRef(
  command(({ get, set }, handle: HTMLDivElement, mountSignal: AbortSignal) => {
    handle.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.isPrimary || event.button !== 0) {
          return;
        }
        const container = handle.parentElement;
        if (!container) {
          return;
        }
        const ownerSignal = AbortSignal.any([mountSignal, get(pageSignal$)]);
        if (ownerSignal.aborted) {
          return;
        }
        // Resizing owns this gesture; do not start native text selection.
        event.preventDefault();
        set(
          startChatThreadSidebarResize$,
          container,
          handle,
          { pointerId: event.pointerId, startX: event.clientX },
          ownerSignal,
        );
      },
      { signal: mountSignal },
    );
    handle.addEventListener(
      "dblclick",
      () => {
        if (get(unifiedChatWorkspace$)) {
          set(writeSidebarWidth$, handle.dataset.widthKey ?? "", null);
        }
      },
      { signal: mountSignal },
    );
    handle.addEventListener(
      "keydown",
      (event) => {
        const container = handle.parentElement;
        if (!get(unifiedChatWorkspace$) || !container) {
          return;
        }
        const key = handle.dataset.widthKey ?? "";
        const containerWidth = container.getBoundingClientRect().width;
        const maxWidth = Math.max(
          CHAT_THREAD_SIDEBAR_MIN_WIDTH,
          containerWidth - UNIFIED_CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
        );
        const width = Math.min(
          get(unifiedChatThreadSidebarWidths$)[key] ??
            unifiedDefaultWidth(containerWidth),
          maxWidth,
        );
        const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
        // The panel sits right of the divider: moving it left widens it.
        const next =
          event.key === "ArrowLeft"
            ? width + step
            : event.key === "ArrowRight"
              ? width - step
              : event.key === "Home"
                ? CHAT_THREAD_SIDEBAR_MIN_WIDTH
                : event.key === "End"
                  ? maxWidth
                  : null;
        if (event.key === "Enter") {
          // The focused separator owns Enter as "restore the default width".
          event.preventDefault();
          set(writeSidebarWidth$, key, null);
          return;
        }
        if (next === null) {
          return;
        }
        // Arrow, Home and End keys resize instead of scrolling the page.
        event.preventDefault();
        set(
          writeSidebarWidth$,
          key,
          Math.min(Math.max(next, CHAT_THREAD_SIDEBAR_MIN_WIDTH), maxWidth),
        );
      },
      { signal: mountSignal },
    );
  }),
);
