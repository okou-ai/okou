import { computed } from "ccstate";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { sidebarActiveThreadIds$ } from "../chat-page/chat-thread-indicators-from-worker.ts";
import { sidebarUnreadThreadIds$ } from "../chat-page/sidebar-unread-threads.ts";
import { pathParams$ } from "../route.ts";

/** What a folded Project reports about the chats it hides. */
export type ProjectIndicatorState = "running" | "unread";

/**
 * The state each Project's unarchived chats add up to, ranked as a chat row
 * ranks its own: a running chat outranks an unread one. The open chat counts
 * as running but never as unread. A Project with neither has no entry.
 */
export const projectIndicatorStates$ = computed(
  async (get): Promise<ReadonlyMap<string, ProjectIndicatorState>> => {
    const runningThreadIds = await get(sidebarActiveThreadIds$);
    const unreadThreadIds = await get(sidebarUnreadThreadIds$);
    const currentThreadId = get(pathParams$)?.threadId;
    const states = new Map<string, ProjectIndicatorState>();
    for (const thread of get(eventDrivenChatThreads$)) {
      if (thread.projectId === null || thread.archived) {
        continue;
      }
      if (runningThreadIds.has(thread.id)) {
        states.set(thread.projectId, "running");
      } else if (
        !states.has(thread.projectId) &&
        thread.id !== currentThreadId &&
        unreadThreadIds.has(thread.id)
      ) {
        states.set(thread.projectId, "unread");
      }
    }
    return states;
  },
);
