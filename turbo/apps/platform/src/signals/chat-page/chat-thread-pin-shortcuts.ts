import { command } from "ccstate";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { shouldHandleShortcutPress } from "../okou-page/nav.ts";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";
import {
  pinnedThreadReorderEnabled$,
  stepPinnedThread$,
} from "./chat-thread-pin-order.ts";

function focusedPinShortcutThreadId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const owner = target.closest<HTMLElement>(
    "[data-chat-thread-menu-thread-id], [data-sidebar-chat-thread-row-id], [data-chat-thread-container-id]",
  );
  return (
    owner?.dataset.chatThreadMenuThreadId ??
    owner?.dataset.sidebarChatThreadRowId ??
    owner?.dataset.chatThreadContainerId ??
    null
  );
}

export const setupChatThreadPinShortcuts$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const targetThreadId = (event: KeyboardEvent) => {
      return (
        focusedPinShortcutThreadId(event.target) ?? get(currentChatThreadId$)
      );
    };
    const shouldHandle = (event: KeyboardEvent) => {
      if (
        !shouldHandleShortcutPress(event) ||
        !get(pinnedThreadReorderEnabled$)
      ) {
        return false;
      }
      // A different menu owns its keyboard; never reorder the main chat from it.
      if (
        document.querySelector('[role="menu"]') &&
        !(
          event.target instanceof Element &&
          event.target.closest("[data-chat-thread-menu-thread-id]")
        )
      ) {
        return false;
      }
      const threadId = targetThreadId(event);
      if (!threadId) {
        return false;
      }
      const thread = get(chatThreadMetaMap$).get(threadId);
      return thread !== undefined && thread.pinnedAt !== null;
    };
    const move = async (event: KeyboardEvent, direction: -1 | 1) => {
      const threadId = targetThreadId(event);
      if (threadId) {
        await set(stepPinnedThread$, threadId, direction, signal);
      }
    };
    setupGlobalShortcut(
      {
        [GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinUp.binding]: {
          shouldHandle,
          run: (event) => {
            return move(event, -1);
          },
        },
        [GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinDown.binding]: {
          shouldHandle,
          run: (event) => {
            return move(event, 1);
          },
        },
      },
      signal,
    );
  },
);
