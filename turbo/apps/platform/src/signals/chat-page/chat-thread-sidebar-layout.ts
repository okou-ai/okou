import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";

import { localStorageSignals } from "../external/local-storage.ts";
import {
  CHAT_LIST_FOLD_DISTANCE,
  CHAT_LIST_MIN_WIDTH,
  chatListWidth$,
  commitChatListWidth$,
  createResizeMask,
  setLiveChatListWidth$,
  setStoredChatListHidden$,
  storedChatListHidden$,
  unifiedChatWorkspace$,
} from "../okou-page/unified-chat-workspace.ts";
import { pageSignal$ } from "../page-signal.ts";
import { isNonArrayRecord, jsonParseOr, onRef, resetSignal } from "../utils.ts";
import { syncActiveBrowserFitAction$ } from "./thread-sidebar-coordinator.ts";

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
  const listWidth = geometry.listWidth - (desired - maxWithList);
  if (listWidth >= CHAT_LIST_MIN_WIDTH) {
    return result(desired, listWidth, false);
  }
  if (CHAT_LIST_MIN_WIDTH - listWidth > CHAT_LIST_FOLD_DISTANCE) {
    return result(Math.min(desired, foldedMax), geometry.listWidth, true);
  }
  return result(
    maxWithList + geometry.listWidth - CHAT_LIST_MIN_WIDTH,
    CHAT_LIST_MIN_WIDTH,
    false,
  );
}

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

const chatThreadSidebarDragMaskEl$ = computed(() => {
  return createResizeMask("data-chat-thread-sidebar-resize-mask", "col-resize");
});

const startChatThreadSidebarResize$ = command(
  (
    { get, set },
    container: HTMLElement,
    handle: HTMLDivElement,
    pointerId: number,
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
    const dragSignal = set(resetChatThreadSidebarResize$, ownerSignal);
    // Capture before mounting the mask so a failed capture cannot leave it
    // blocking the page. Events stay on this owner across embedded frames.
    handle.setPointerCapture(pointerId);
    const dragMaskEl = get(chatThreadSidebarDragMaskEl$);
    let fitCheckScheduled = false;

    function resetResize(): void {
      if (unifiedKey !== null) {
        set(commitLiveSidebarWidth$);
        set(commitChatListWidth$);
      }
      set(resetChatThreadSidebarResize$);
    }

    function moveUnified(key: string, pointerX: number): void {
      const next = unifiedDragLayout(unifiedGeometry, pointerX);
      // At a limit the cursor points the only way the divider can still go.
      dragMaskEl.style.cursor = next.atMax
        ? "e-resize"
        : next.atMin
          ? "w-resize"
          : "col-resize";
      set(setStoredChatListHidden$, next.listHidden);
      set(
        setLiveChatListWidth$,
        next.listWidth === unifiedGeometry.listWidth ? null : next.listWidth,
      );
      set(internalLiveSidebarWidth$, { key, width: Math.round(next.width) });
    }

    function endPointerResize(event: PointerEvent): void {
      if (event.pointerId === pointerId) {
        resetResize();
      }
    }

    function scheduleBrowserFitCheck(): void {
      if (fitCheckScheduled) {
        return;
      }
      fitCheckScheduled = true;
      // React applies the width subscription after this native pointer event.
      // Keep the final check alive through pointerup so it measures the
      // committed sidebar size on the next frame.
      animationFrame(
        () => {
          fitCheckScheduled = false;
          set(syncActiveBrowserFitAction$);
        },
        { signal: ownerSignal },
      );
    }

    handle.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== pointerId) {
          return;
        }
        if (event.buttons === 0) {
          resetResize();
          return;
        }
        if (unifiedKey === null) {
          const nextWidth = Math.min(
            Math.max(rect.right - event.clientX, CHAT_THREAD_SIDEBAR_MIN_WIDTH),
            maxWidth,
          );
          set(setChatThreadSidebarWidth$, nextWidth);
        } else {
          moveUnified(unifiedKey, event.clientX);
        }
        scheduleBrowserFitCheck();
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
          event.pointerId,
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
          set(syncActiveBrowserFitAction$);
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
          set(syncActiveBrowserFitAction$);
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
        set(syncActiveBrowserFitAction$);
      },
      { signal: mountSignal },
    );
  }),
);
