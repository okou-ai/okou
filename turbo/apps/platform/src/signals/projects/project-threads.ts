import { computed } from "ccstate";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { sidebarUnreadThreadIds$ } from "../chat-page/sidebar-unread-threads.ts";
import { pathParams$ } from "../route.ts";

/** Projects whose active chats include an unread one outside the open chat. */
export const unreadProjectIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const unreadThreadIds = await get(sidebarUnreadThreadIds$);
    const currentThreadId = get(pathParams$)?.threadId;
    const projectIds = new Set<string>();
    for (const thread of get(eventDrivenChatThreads$)) {
      if (
        thread.projectId !== null &&
        !thread.archived &&
        thread.id !== currentThreadId &&
        unreadThreadIds.has(thread.id)
      ) {
        projectIds.add(thread.projectId);
      }
    }
    return projectIds;
  },
);
