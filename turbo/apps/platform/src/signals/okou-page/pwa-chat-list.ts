import { computed } from "ccstate";
import { currentChatAgentScope$ } from "../agent-chat.ts";
import { unreadAgentIds$ } from "../chat-page/chat-thread-indicators-from-worker.ts";
import { chatThreadOnlyArchived$ } from "../chat-page/chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "../chat-page/chat-thread-only-muted.ts";
import { chatThreadOnlyUnread$ } from "../chat-page/chat-thread-only-unread.ts";
import { createSidebarChatThreadScrollSignals } from "../chat-page/sidebar-chat-thread-scroll.ts";

// A 56px touch row and its 4px gutter share one virtual geometry.
export const PWA_CHAT_THREAD_ROW_HEIGHT = 60;

export const pwaChatThreadScrollSignals$ = computed((get) => {
  // Returning from a conversation retains this graph and its scroll position.
  // A different agent or filter starts a new list at the top.
  get(currentChatAgentScope$);
  get(chatThreadOnlyUnread$);
  get(chatThreadOnlyArchived$);
  get(chatThreadOnlyMuted$);
  return createSidebarChatThreadScrollSignals({
    rowHeight: PWA_CHAT_THREAD_ROW_HEIGHT,
    restoreScrollPosition: true,
  });
});

export const pwaHasUnreadChats$ = computed(async (get) => {
  return (await get(unreadAgentIds$)).size > 0;
});
