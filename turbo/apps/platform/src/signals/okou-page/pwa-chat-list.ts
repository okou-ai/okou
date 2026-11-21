import { computed } from "ccstate";

import { sidebarUnreadThreadIds$ } from "../chat-page/sidebar-unread-threads.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { chatThreadOnlyArchived$ } from "../chat-page/chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "../chat-page/chat-thread-only-muted.ts";
import { chatThreadOnlyUnread$ } from "../chat-page/chat-thread-only-unread.ts";
import { createSidebarChatThreadScrollSignals } from "../chat-page/sidebar-chat-thread-scroll.ts";

// A 56px touch row and its 4px gutter share one virtual geometry.
export const PWA_CHAT_THREAD_ROW_HEIGHT = 60;

export const pwaChatThreadScrollSignals$ = computed((get) => {
  // Returning from a conversation retains this graph and its scroll position.
  // A different filter starts a new list at the top.
  get(chatThreadOnlyUnread$);
  get(chatThreadOnlyArchived$);
  get(chatThreadOnlyMuted$);
  return createSidebarChatThreadScrollSignals({
    rowHeight: PWA_CHAT_THREAD_ROW_HEIGHT,
    restoreScrollPosition: true,
  });
});

export const pwaHasUnreadChats$ = computed(async (get) => {
  const unread = await get(sidebarUnreadThreadIds$);
  const archived = new Set(
    get(eventDrivenChatThreads$)
      .filter((thread) => {
        return thread.archived;
      })
      .map((thread) => {
        return thread.id;
      }),
  );
  return [...unread].some((threadId) => {
    return !archived.has(threadId);
  });
});
