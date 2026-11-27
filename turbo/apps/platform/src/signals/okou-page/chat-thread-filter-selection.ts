import { command } from "ccstate";
import { isEditableTarget } from "@okouai/ui";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import {
  currentChatThreadId$,
  currentChatThreadListIds$,
} from "../chat-thread-list.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { currentRightThread$ } from "../chat-page/chat-thread-pane-state.ts";
import { loadLeftThread$ } from "../chat-page/chat-thread-pane-navigation.ts";
import { resetSignal } from "../utils.ts";
import {
  activeChatThreadFilter$,
  chatThreadFilter$,
  setChatThreadFilter$,
  type ChatThreadFilter,
} from "./chat-thread-filter.ts";
import { shouldHandleShortcutPress } from "./nav.ts";
import { agentChatPageActive$ } from "../active-route.ts";
import { pwaChatListVisible$ } from "./pwa-navigation.ts";
import { cancelProjectFoldAnimations$ } from "../projects/project-fold.ts";

const resetChatThreadFilterSelection$ = resetSignal();

// Selecting a filter keeps the main chat when the filter still lists it and
// otherwise opens the first listed chat. Only the latest selection navigates,
// so rapid toggles never land on a stale list.
export const selectChatThreadFilter$ = command(
  async ({ get, set }, filter: ChatThreadFilter, parentSignal: AbortSignal) => {
    const signal = set(resetChatThreadFilterSelection$, parentSignal);
    set(cancelProjectFoldAnimations$);
    set(setChatThreadFilter$, filter);

    if (get(pwaChatListVisible$) && (await get(agentChatPageActive$))) {
      return;
    }

    const [threadIds, activeFilter] = await Promise.all([
      get(currentChatThreadListIds$),
      get(activeChatThreadFilter$),
    ]);
    signal.throwIfAborted();

    const currentThreadId = get(currentChatThreadId$);
    if (currentThreadId) {
      // All also contains Project chats, including children of folded Projects.
      const listed =
        activeFilter === "all"
          ? get(eventDrivenChatThreads$).some((thread) => {
              return thread.id === currentThreadId;
            })
          : threadIds.includes(currentThreadId);
      if (listed) {
        return;
      }
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

// The Chat rail entry always lands on the inbox. It also supersedes a pending
// filter selection, so that selection cannot open a filtered chat after the
// rail has navigated away.
export const showChatThreadInbox$ = command(({ set }) => {
  set(cancelProjectFoldAnimations$);
  set(resetChatThreadFilterSelection$);
  set(setChatThreadFilter$, "unarchived");
});

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
              get(chatThreadFilter$) === "unread" ? "unarchived" : "unread",
              signal,
            );
          },
        },
      },
      signal,
    );
  },
);
