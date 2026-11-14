import { command, computed, state } from "ccstate";
import { refreshWorkspaceLayout$ } from "./workspace-layout.ts";

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
} from "../okou-page/unified-chat-workspace.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  detach,
  isNonArrayRecord,
  jsonParseOr,
  onDomEventFn,
  onRef,
  Reason,
  resetSignal,
  waitForBrowserPaint,
} from "../utils.ts";

// Smallest the sidebar may shrink to before its content stops being usable.
export const CHAT_THREAD_SIDEBAR_MIN_WIDTH = 400;
// Width the chat thread keeps so its composer never collapses. The side panel
// gets the rest: a 1440px browser screen is scaled to the panel, so its width
// is what keeps pages legible.
export const CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH = 420;
// Share of the space beside the chat list a panel opens at before resizing.
export const CHAT_THREAD_SIDEBAR_DEFAULT_SHARE = 0.55;
// The frame margin the sheet gains when the chat list folds away.
const WORKSPACE_FRAME_GAP = 8;
const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 64;

// Each panel kind keeps its own width, because a browser wants room while a
// resource list reads best narrow.
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

export const chatThreadSidebarWidths$ = computed((get) => {
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

interface SidebarDragGeometry {
  readonly containerRight: number;
  readonly containerWidth: number;
  readonly listWidth: number;
  readonly listHidden: boolean;
}

interface SidebarDragResult {
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
function sidebarDragLayout(
  geometry: SidebarDragGeometry,
  pointerX: number,
  listFolded: boolean,
): SidebarDragResult {
  const desired = geometry.containerRight - pointerX;
  const maxWithList =
    geometry.containerWidth - CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH;
  const foldedMax = geometry.listHidden
    ? maxWithList
    : maxWithList + geometry.listWidth - WORKSPACE_FRAME_GAP;
  const result = (
    width: number,
    listWidth: number,
    listHidden: boolean,
  ): SidebarDragResult => {
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

const resizeSidebar$ = command(
  (
    { get, set },
    key: string,
    next: SidebarDragResult,
    initialListWidth: number,
    signal: AbortSignal,
  ) => {
    set(setStoredChatListHidden$, next.listHidden, signal);
    set(
      setLiveChatListWidth$,
      next.listWidth === initialListWidth ? null : next.listWidth,
      signal,
    );
    const width = Math.round(next.width);
    const live = get(internalLiveSidebarWidth$);
    if (!live || live.key !== key || live.width !== width) {
      set(internalLiveSidebarWidth$, { key, width });
      detach(
        set(refreshWorkspaceLayout$, signal),
        Reason.DomCallback,
        "live utility sidebar width layout",
      );
    }
  },
);

/** Width the panel renders at before any resize, as the shell's CSS does. */
function defaultSidebarWidth(containerWidth: number): number {
  return Math.max(
    CHAT_THREAD_SIDEBAR_MIN_WIDTH,
    Math.min(
      containerWidth * CHAT_THREAD_SIDEBAR_DEFAULT_SHARE,
      containerWidth - CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
    ),
  );
}

const internalChatThreadSidebarResizing$ = state(false);
export const chatThreadSidebarResizing$ = computed((get) => {
  return get(internalChatThreadSidebarResizing$);
});

const resetChatThreadSidebarResize$ = resetSignal();

const finishChatThreadSidebarResize$ = command(
  async ({ set }, signal: AbortSignal, ownerSignal: AbortSignal) => {
    // Persist the terminal sample before page cancellation can interrupt paint.
    set(commitLiveSidebarWidth$);
    set(commitChatListWidth$);
    // Paint the final coordinate while this gesture still owns transitions.
    await waitForBrowserPaint(signal);
    signal.throwIfAborted();
    // Capture and the mask are already released; now relinquish transitions.
    set(resetChatThreadSidebarResize$);
    await set(refreshWorkspaceLayout$, ownerSignal);
  },
);

const changeSidebarWidth$ = command(
  async ({ set }, key: string, width: number | null, signal: AbortSignal) => {
    set(writeSidebarWidth$, key, width);
    await set(refreshWorkspaceLayout$, signal);
  },
);

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
    const widthKey = handle.dataset.widthKey ?? "";
    const geometry: SidebarDragGeometry = {
      containerRight: rect.right,
      containerWidth: rect.width,
      listWidth: get(chatListWidth$),
      listHidden: get(storedChatListHidden$),
    };
    let listFolded = geometry.listHidden;
    const handleRect = handle.getBoundingClientRect();
    // Keep the distance from the seam's centre instead of snapping a wide hit
    // target to the pointer. Non-rendered synthetic handles have no geometry.
    const grabOffset =
      handleRect.width > 0
        ? startX - (handleRect.left + handleRect.width / 2)
        : 0;
    const dragSignal = set(resetChatThreadSidebarResize$, ownerSignal);
    // Capture before mounting the mask so a failed capture cannot leave it
    // blocking the page. Events stay on this owner across embedded frames.
    handle.setPointerCapture(pointerId);
    const dragMaskEl = get(chatThreadSidebarDragMaskEl$);

    let finishing = false;
    function resetResize(): Promise<void> | undefined {
      if (dragSignal.aborted || finishing) {
        return;
      }
      finishing = true;
      dragMaskEl.remove();
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      return set(finishChatThreadSidebarResize$, dragSignal, ownerSignal);
    }

    function moveResize(pointerX: number): void {
      if (dragSignal.aborted || finishing || !Number.isFinite(pointerX)) {
        return;
      }
      const next = sidebarDragLayout(
        geometry,
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
      set(resizeSidebar$, widthKey, next, geometry.listWidth, dragSignal);
    }

    function endPointerResize(event: PointerEvent): Promise<void> | undefined {
      if (event.pointerId !== pointerId || dragSignal.aborted || finishing) {
        return;
      }
      const pointerX =
        event.type === "pointerup" ? resizePointerClientX(event) : null;
      if (pointerX !== null) {
        moveResize(pointerX);
      }
      return resetResize();
    }

    handle.addEventListener(
      "pointermove",
      onDomEventFn<PointerEvent>((event) => {
        if (event.pointerId !== pointerId || dragSignal.aborted || finishing) {
          return;
        }
        if (event.buttons === 0) {
          return resetResize();
        }
        moveResize(event.clientX);
        return;
      }),
      { signal: dragSignal },
    );
    handle.addEventListener("pointerup", onDomEventFn(endPointerResize), {
      signal: dragSignal,
    });
    handle.addEventListener("pointercancel", onDomEventFn(endPointerResize), {
      signal: dragSignal,
    });
    handle.addEventListener(
      "lostpointercapture",
      onDomEventFn(endPointerResize),
      {
        signal: dragSignal,
      },
    );
    window.addEventListener("blur", onDomEventFn(resetResize), {
      signal: dragSignal,
    });

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
    // Freeze a measurable seam before cancelling an in-flight width animation.
    if (handleRect.width > 0) {
      moveResize(startX);
    }
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
      onDomEventFn(() => {
        return set(
          changeSidebarWidth$,
          handle.dataset.widthKey ?? "",
          null,
          AbortSignal.any([mountSignal, get(pageSignal$)]),
        );
      }),
      { signal: mountSignal },
    );
    handle.addEventListener(
      "keydown",
      onDomEventFn<KeyboardEvent>((event) => {
        const container = handle.parentElement;
        if (!container) {
          return;
        }
        const signal = AbortSignal.any([mountSignal, get(pageSignal$)]);
        const key = handle.dataset.widthKey ?? "";
        const containerWidth = container.getBoundingClientRect().width;
        const maxWidth = Math.max(
          CHAT_THREAD_SIDEBAR_MIN_WIDTH,
          containerWidth - CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
        );
        const width = Math.min(
          get(chatThreadSidebarWidths$)[key] ??
            defaultSidebarWidth(containerWidth),
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
          return set(changeSidebarWidth$, key, null, signal);
        }
        if (next === null) {
          return;
        }
        // Arrow, Home and End keys resize instead of scrolling the page.
        event.preventDefault();
        return set(
          changeSidebarWidth$,
          key,
          Math.min(Math.max(next, CHAT_THREAD_SIDEBAR_MIN_WIDTH), maxWidth),
          signal,
        );
      }),
      { signal: mountSignal },
    );
  }),
);
