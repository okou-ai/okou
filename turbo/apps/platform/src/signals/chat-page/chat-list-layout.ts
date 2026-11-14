import { command } from "ccstate";
import { pwaChatThreadScrollSignals$ } from "../okou-page/pwa-chat-list.ts";
import { rootSignal$ } from "../root-signal.ts";
import { detach, onRef, Reason, waitForBrowserPaint } from "../utils.ts";
import { threeColumnSidebarChatThreadScrollSignals } from "./sidebar-chat-thread-scroll.ts";

/**
 * Awaited by the operation that changes the space beside the chat list. The
 * paint boundary follows that change, so every chat list viewport reads its
 * new height then; an unmounted viewport has nothing to read.
 */
export const refreshChatListLayout$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await waitForBrowserPaint(signal);
    signal.throwIfAborted();
    set(threeColumnSidebarChatThreadScrollSignals.measureViewport$);
    set(get(pwaChatThreadScrollSignals$).measureViewport$);
  },
);

// Pinned entries and upgrade cards consume space beside the chat viewport.
// Their committed insertion/removal, including async data updates, determines
// when the remaining height needs to be measured again.
export const refreshSidebarChatThreadLayoutOnRef$ = onRef(
  command(async ({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
    // The removal's refresh outlives the element that leaves.
    const rootSignal = get(rootSignal$);
    signal.addEventListener(
      "abort",
      () => {
        detach(
          set(refreshChatListLayout$, rootSignal),
          Reason.DomCallback,
          "chat list layout after removal",
        );
      },
      { once: true },
    );
    await set(refreshChatListLayout$, signal);
  }),
);
