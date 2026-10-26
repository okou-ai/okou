import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";

import { featureSwitch$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { pageSignal$ } from "../page-signal.ts";
import { onRef, resetSignal } from "../utils.ts";

// ---------------------------------------------------------------------------
// Unified chat workspace (Lab). The chat list, the chat and its side panel
// share one sheet, and the dividers between them remember their widths.
// ---------------------------------------------------------------------------

export const unifiedChatWorkspace$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.UnifiedChatWorkspace];
});

const CHAT_LIST_DEFAULT_WIDTH = 300;
export const CHAT_LIST_MIN_WIDTH = 240;
export const CHAT_LIST_MAX_WIDTH = 420;
// Dragging this far past the minimum folds the list away, the same state as
// the Hide chat list button.
export const CHAT_LIST_FOLD_DISTANCE = 72;
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
  ({ get, set }, hidden: boolean) => {
    if (get(storedChatListHidden$) !== hidden) {
      set(chatListHiddenStorage.set$, String(hidden));
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
  ({ set }, width: number | null) => {
    set(
      internalLiveChatListWidth$,
      width === null ? null : clampChatListWidth(width),
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

const setChatListWidth$ = command(({ set }, width: number) => {
  set(internalLiveChatListWidth$, null);
  set(chatListWidthStorage.set$, String(clampChatListWidth(width)));
});

const resetChatListWidth$ = command(({ set }) => {
  set(internalLiveChatListWidth$, null);
  set(chatListWidthStorage.clear$);
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

const startChatListResize$ = command(
  (
    { get, set },
    handle: HTMLDivElement,
    pointerId: number,
    startX: number,
    ownerSignal: AbortSignal,
  ): void => {
    ownerSignal.throwIfAborted();
    const startWidth = get(chatListWidth$);
    const dragSignal = set(resetChatListResize$, ownerSignal);
    handle.setPointerCapture(pointerId);
    const mask = createResizeMask("data-chat-list-resize-mask", "col-resize");

    function endResize(event: PointerEvent): void {
      if (event.pointerId === pointerId) {
        set(commitChatListWidth$);
        set(resetChatListResize$);
      }
    }

    handle.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== pointerId) {
          return;
        }
        if (event.buttons === 0) {
          endResize(event);
          return;
        }
        const desired = startWidth + event.clientX - startX;
        if (desired < CHAT_LIST_MIN_WIDTH - CHAT_LIST_FOLD_DISTANCE) {
          // Folding unmounts this handle, which aborts the gesture.
          set(setLiveChatListWidth$, null);
          set(setStoredChatListHidden$, true);
          set(resetChatListResize$);
          return;
        }
        mask.style.cursor =
          desired >= CHAT_LIST_MAX_WIDTH ? "w-resize" : "col-resize";
        set(setLiveChatListWidth$, desired);
      },
      { signal: dragSignal },
    );
    handle.addEventListener("pointerup", endResize, { signal: dragSignal });
    handle.addEventListener("pointercancel", endResize, { signal: dragSignal });
    handle.addEventListener("lostpointercapture", endResize, {
      signal: dragSignal,
    });
    window.addEventListener(
      "blur",
      () => {
        set(commitChatListWidth$);
        set(resetChatListResize$);
      },
      { signal: dragSignal },
    );

    dragSignal.addEventListener(
      "abort",
      () => {
        if (handle.isConnected && handle.hasPointerCapture(pointerId)) {
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
      () => {
        set(resetChatListWidth$);
      },
      { signal: mountSignal },
    );
    handle.addEventListener(
      "keydown",
      (event) => {
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
          set(resetChatListWidth$);
          return;
        }
        if (next === null) {
          return;
        }
        // Arrow, Home and End keys resize instead of scrolling the list.
        event.preventDefault();
        set(setChatListWidth$, next);
      },
      { signal: mountSignal },
    );
  }),
);
