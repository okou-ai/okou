import { command } from "ccstate";
import { isEditableTarget } from "@okouai/ui";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import {
  currentChatThreadId$,
  currentChatThreadListIds$,
} from "../agent-chat.ts";
import { chatThreadOnlyUnread$ } from "../chat-page/chat-thread-only-unread.ts";
import { currentRightThread$ } from "../chat-page/chat-thread-pane-state.ts";
import { loadLeftThread$ } from "../chat-page/chat-thread-panes.ts";
import { resetSignal } from "../utils.ts";
import {
  setChatThreadArchivedFilter$,
  setChatThreadUnreadFilter$,
} from "./chat-thread-filter.ts";
import { shouldHandleShortcutPress } from "./nav.ts";

export type ChatThreadFilter = "all" | "unread" | "archived";

const resetChatThreadFilterSelection$ = resetSignal();

// Selecting a filter keeps the main chat when the filter still lists it and
// otherwise opens the first listed chat. Only the latest selection navigates,
// so rapid toggles never land on a stale list.
export const selectChatThreadFilter$ = command(
  async ({ get, set }, filter: ChatThreadFilter, parentSignal: AbortSignal) => {
    const signal = set(resetChatThreadFilterSelection$, parentSignal);
    if (filter === "archived") {
      set(setChatThreadArchivedFilter$);
    } else {
      set(setChatThreadUnreadFilter$, filter === "unread");
    }

    const threadIds = await get(currentChatThreadListIds$);
    signal.throwIfAborted();

    const currentThreadId = get(currentChatThreadId$);
    if (currentThreadId && threadIds.includes(currentThreadId)) {
      return;
    }

    const rightThreadId = get(currentRightThread$)?.threadId;
    const targetId = threadIds.find((threadId) => {
      return threadId !== rightThreadId;
    });
    if (targetId) {
      set(loadLeftThread$, targetId);
    }
  },
);

function shouldHandleUnreadOnlyShortcut(event: KeyboardEvent): boolean {
  if (!shouldHandleShortcutPress(event)) {
    return false;
  }
  return !(
    /Linux/u.test(navigator.userAgent) && isEditableTarget(event.target)
  );
}

export const setupChatThreadFilterShortcut$ = command(
  ({ get, set }, signal: AbortSignal) => {
    setupGlobalShortcut(
      {
        [GLOBAL_KEYBOARD_SHORTCUTS.toggleUnreadOnly.binding]: {
          allowInEditableTarget: true,
          shouldHandle: shouldHandleUnreadOnlyShortcut,
          run: async () => {
            await set(
              selectChatThreadFilter$,
              get(chatThreadOnlyUnread$) ? "all" : "unread",
              signal,
            );
          },
        },
      },
      signal,
    );
  },
);
