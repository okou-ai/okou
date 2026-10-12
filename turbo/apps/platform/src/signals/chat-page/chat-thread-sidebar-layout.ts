import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";

import { pageSignal$ } from "../page-signal.ts";
import { onRef, resetSignal } from "../utils.ts";
import { syncActiveBrowserFitAction$ } from "./thread-sidebar-coordinator.ts";

// Smallest the sidebar may shrink to before its content stops being usable.
export const CHAT_THREAD_SIDEBAR_MIN_WIDTH = 400;
// Width the chat thread keeps so its composer never collapses.
export const CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH = 600;

const internalChatThreadSidebarWidth$ = state<number | null>(null);

export const chatThreadSidebarWidth$ = computed<number | null>((get) => {
  return get(internalChatThreadSidebarWidth$);
});

const setChatThreadSidebarWidth$ = command(({ set }, width: number) => {
  set(internalChatThreadSidebarWidth$, Math.round(width));
});

const internalChatThreadSidebarResizing$ = state(false);
export const chatThreadSidebarResizing$ = computed((get) => {
  return get(internalChatThreadSidebarResizing$);
});

const resetChatThreadSidebarResize$ = resetSignal();

const chatThreadSidebarDragMaskEl$ = computed(() => {
  const element = document.createElement("div");
  element.dataset.chatThreadSidebarResizeMask = "";
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, {
    background: "transparent",
    cursor: "col-resize",
    inset: "0",
    position: "fixed",
    touchAction: "none",
    userSelect: "none",
    zIndex: "2147483647",
  });
  return element;
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
    const dragSignal = set(resetChatThreadSidebarResize$, ownerSignal);
    // Capture before mounting the mask so a failed capture cannot leave it
    // blocking the page. Events stay on this owner across embedded frames.
    handle.setPointerCapture(pointerId);
    const dragMaskEl = get(chatThreadSidebarDragMaskEl$);
    let fitCheckScheduled = false;

    function resetResize(): void {
      set(resetChatThreadSidebarResize$);
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
        const nextWidth = Math.min(
          Math.max(rect.right - event.clientX, CHAT_THREAD_SIDEBAR_MIN_WIDTH),
          maxWidth,
        );
        set(setChatThreadSidebarWidth$, nextWidth);
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
  }),
);
