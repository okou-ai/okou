import { command, computed, state } from "ccstate";
import { refreshWorkspaceLayout$ } from "../chat-page/workspace-layout.ts";

import { localStorageSignals } from "../external/local-storage.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  detach,
  onDomEventFn,
  onRef,
  Reason,
  resetSignal,
  waitForBrowserPaint,
} from "../utils.ts";

// ---------------------------------------------------------------------------
// Unified chat workspace. The chat list, the chat and its side panel share one
// sheet, and the dividers between them remember their widths.
// ---------------------------------------------------------------------------

const CHAT_LIST_DEFAULT_WIDTH = 300;
export const CHAT_LIST_MIN_WIDTH = 240;
export const CHAT_LIST_MAX_WIDTH = 420;
// Once folded, reverse this far past the fold boundary before restoring the
// list, so a small pointer wobble cannot toggle it repeatedly.
export const CHAT_LIST_RESTORE_DISTANCE = 16;
const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 64;

function clampChatListWidth(width: number): number {
  return Math.round(
    Math.min(Math.max(width, CHAT_LIST_MIN_WIDTH), CHAT_LIST_MAX_WIDTH),
  );
}

const chatListHiddenStorage = localStorageSignals("chat-list-hidden");

export const storedChatListHidden$ = computed((get) => {
  return get(chatListHiddenStorage.get$) === "true";
});

export const setStoredChatListHidden$ = command(
  ({ get, set }, hidden: boolean, signal?: AbortSignal) => {
    if (get(storedChatListHidden$) !== hidden) {
      set(chatListHiddenStorage.set$, String(hidden));
      // Preserve synchronous callers while the page or gesture owns geometry work.
      detach(
        set(refreshWorkspaceLayout$, signal ?? get(pageSignal$)),
        Reason.DomCallback,
        "chat list visibility layout",
      );
    }
  },
);

const chatListWidthStorage = localStorageSignals("chat-list-width");
// A drag shows its width live and writes storage once, when it ends.
const internalLiveChatListWidth$ = state<number | null>(null);

export const chatListWidth$ = computed((get) => {
  const live = get(internalLiveChatListWidth$);
  if (live !== null) {
    return live;
  }
  const stored = Number(get(chatListWidthStorage.get$));
  return Number.isFinite(stored) && stored > 0
    ? clampChatListWidth(stored)
    : CHAT_LIST_DEFAULT_WIDTH;
});

export const setLiveChatListWidth$ = command(
  ({ get, set }, width: number | null, signal?: AbortSignal) => {
    const next = width === null ? null : clampChatListWidth(width);
    if (get(internalLiveChatListWidth$) === next) {
      return;
    }
    set(internalLiveChatListWidth$, next);
    detach(
      set(refreshWorkspaceLayout$, signal ?? get(pageSignal$)),
      Reason.DomCallback,
      "live chat list width layout",
    );
  },
);

export const commitChatListWidth$ = command(({ get, set }) => {
  const live = get(internalLiveChatListWidth$);
  if (live === null) {
    return;
  }
  set(chatListWidthStorage.set$, String(live));
  set(internalLiveChatListWidth$, null);
});

const setChatListWidth$ = command(
  async ({ set }, width: number, signal: AbortSignal) => {
    set(internalLiveChatListWidth$, null);
    set(chatListWidthStorage.set$, String(clampChatListWidth(width)));
    await set(refreshWorkspaceLayout$, signal);
  },
);

const resetChatListWidth$ = command(async ({ set }, signal: AbortSignal) => {
  set(internalLiveChatListWidth$, null);
  set(chatListWidthStorage.clear$);
  set(setStoredChatListHidden$, false, signal);
  await set(refreshWorkspaceLayout$, signal);
});

const resetChatListResize$ = resetSignal();

const internalChatListResizing$ = state(false);
export const chatListResizing$ = computed((get) => {
  return get(internalChatListResizing$);
});

/** A full-page layer that keeps the resize cursor and swallows the gesture. */
export function createResizeMask(
  attribute: string,
  cursor: string,
): HTMLDivElement {
  const element = document.createElement("div");
  element.setAttribute(attribute, "");
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, {
    background: "transparent",
    cursor,
    inset: "0",
    position: "fixed",
    touchAction: "none",
    userSelect: "none",
    zIndex: "2147483647",
  });
  return element;
}

/** Release coordinates are valid resize samples, including the viewport origin. */
export function resizePointerClientX(event: PointerEvent): number | null {
  return Number.isFinite(event.clientX) ? event.clientX : null;
}

const resizeChatList$ = command(
  (
    { get, set },
    desired: number,
    startedHidden: boolean,
    signal: AbortSignal,
  ) => {
    // A gesture from the collapsed seam starts at zero; a visible list folds
    // as soon as its usable minimum is exhausted.
    const foldWidth = startedHidden ? 0 : CHAT_LIST_MIN_WIDTH;
    const threshold =
      foldWidth + (get(storedChatListHidden$) ? CHAT_LIST_RESTORE_DISTANCE : 0);
    const hidden = desired < threshold;
    set(setLiveChatListWidth$, hidden ? null : desired, signal);
    set(setStoredChatListHidden$, hidden, signal);
    return hidden;
  },
);

const finishChatListResize$ = command(
  async ({ set }, signal: AbortSignal, ownerSignal: AbortSignal) => {
    // Paint the final live coordinate while this gesture still owns transitions.
    await waitForBrowserPaint(signal);
    signal.throwIfAborted();
    // Capture and the mask are already released; now relinquish transitions.
    set(resetChatListResize$);
    set(commitChatListWidth$);
    await set(refreshWorkspaceLayout$, ownerSignal);
  },
);

const startChatListResize$ = command(
  (
    { get, set },
    handle: HTMLDivElement,
    pointerId: number,
    startX: number,
    ownerSignal: AbortSignal,
  ): void => {
    ownerSignal.throwIfAborted();
    const startedHidden = get(storedChatListHidden$);
    const startWidth = startedHidden ? 0 : get(chatListWidth$);
    const dragSignal = set(resetChatListResize$, ownerSignal);
    handle.setPointerCapture(pointerId);
    const mask = createResizeMask("data-chat-list-resize-mask", "col-resize");

    let finishing = false;
    function finishResize(): Promise<void> | undefined {
      if (dragSignal.aborted || finishing) {
        return;
      }
      finishing = true;
      mask.remove();
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      return set(finishChatListResize$, dragSignal, ownerSignal);
    }

    function moveResize(pointerX: number): void {
      if (dragSignal.aborted || finishing || !Number.isFinite(pointerX)) {
        return;
      }
      const desired = startWidth + pointerX - startX;
      const hidden = set(resizeChatList$, desired, startedHidden, dragSignal);
      mask.style.cursor = hidden
        ? "e-resize"
        : desired >= CHAT_LIST_MAX_WIDTH
          ? "w-resize"
          : "col-resize";
    }

    function endResize(event: PointerEvent): Promise<void> | undefined {
      if (event.pointerId !== pointerId || dragSignal.aborted || finishing) {
        return;
      }
      const pointerX =
        event.type === "pointerup" ? resizePointerClientX(event) : null;
      if (pointerX !== null) {
        moveResize(pointerX);
      }
      return finishResize();
    }

    handle.addEventListener(
      "pointermove",
      onDomEventFn<PointerEvent>((event) => {
        if (event.pointerId !== pointerId || dragSignal.aborted || finishing) {
          return;
        }
        if (event.buttons === 0) {
          return finishResize();
        }
        moveResize(event.clientX);
        return;
      }),
      { signal: dragSignal },
    );
    handle.addEventListener("pointerup", onDomEventFn(endResize), {
      signal: dragSignal,
    });
    handle.addEventListener("pointercancel", onDomEventFn(endResize), {
      signal: dragSignal,
    });
    handle.addEventListener("lostpointercapture", onDomEventFn(endResize), {
      signal: dragSignal,
    });
    window.addEventListener("blur", onDomEventFn(finishResize), {
      signal: dragSignal,
    });

    dragSignal.addEventListener(
      "abort",
      () => {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        mask.remove();
        set(internalChatListResizing$, false);
      },
      { once: true },
    );

    document.body.append(mask);
    set(internalChatListResizing$, true);
  },
);

export const chatListResizeHandleRef$ = onRef(
  command(({ get, set }, handle: HTMLDivElement, mountSignal: AbortSignal) => {
    handle.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.isPrimary || event.button !== 0) {
          return;
        }
        const ownerSignal = AbortSignal.any([mountSignal, get(pageSignal$)]);
        if (ownerSignal.aborted) {
          return;
        }
        // Resizing owns this gesture; do not start native text selection.
        event.preventDefault();
        set(
          startChatListResize$,
          handle,
          event.pointerId,
          event.clientX,
          ownerSignal,
        );
      },
      { signal: mountSignal },
    );
    handle.addEventListener(
      "dblclick",
      onDomEventFn(() => {
        return set(
          resetChatListWidth$,
          AbortSignal.any([mountSignal, get(pageSignal$)]),
        );
      }),
      { signal: mountSignal },
    );
    handle.addEventListener(
      "keydown",
      onDomEventFn<KeyboardEvent>((event) => {
        const signal = AbortSignal.any([mountSignal, get(pageSignal$)]);
        const width = get(chatListWidth$);
        const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
        const next =
          event.key === "ArrowLeft"
            ? width - step
            : event.key === "ArrowRight"
              ? width + step
              : event.key === "Home"
                ? CHAT_LIST_MIN_WIDTH
                : event.key === "End"
                  ? CHAT_LIST_MAX_WIDTH
                  : null;
        if (event.key === "Enter") {
          // The focused separator owns Enter as "restore the default width".
          event.preventDefault();
          return set(resetChatListWidth$, signal);
        }
        if (next === null) {
          return;
        }
        // Arrow, Home and End keys resize instead of scrolling the list.
        event.preventDefault();
        set(setStoredChatListHidden$, false, signal);
        return set(setChatListWidth$, next, signal);
      }),
      { signal: mountSignal },
    );
  }),
);
