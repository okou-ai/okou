import { computed } from "ccstate";
import { currentChatThreadList$ } from "../agent-chat.ts";
import { groupProjectThreadIds } from "../chat-page/chat-thread-list-rows.ts";
import { sidebarActiveThreadIds$ } from "../chat-page/chat-thread-indicators-from-worker.ts";
import { sidebarUnreadThreadIds$ } from "../chat-page/sidebar-unread-threads.ts";
import { pathParams$ } from "../route.ts";

/** What a folded Project reports about the chats it hides. */
export type ProjectIndicatorState = "running" | "unread";

/**
 * The state the chats listed inside each Project add up to, so a folded
 * Project reports the rows it hides under the current list filter. An unread
 * chat outranks a running one. The chat open in the main pane counts as running
 * but never as unread. A Project with neither has no entry.
 */
export const projectIndicatorStates$ = computed(
  async (get): Promise<ReadonlyMap<string, ProjectIndicatorState>> => {
    const list = await get(currentChatThreadList$);
    const runningThreadIds = await get(sidebarActiveThreadIds$);
    const unreadThreadIds = await get(sidebarUnreadThreadIds$);
    const currentThreadId = get(pathParams$)?.threadId;
    const states = new Map<string, ProjectIndicatorState>();
    for (const [projectId, threadIds] of groupProjectThreadIds(
      get(list.projectThreads$),
    )) {
      if (
        threadIds.some((threadId) => {
          return threadId !== currentThreadId && unreadThreadIds.has(threadId);
        })
      ) {
        states.set(projectId, "unread");
      } else if (
        threadIds.some((threadId) => {
          return runningThreadIds.has(threadId);
        })
      ) {
        states.set(projectId, "running");
      }
    }
    return states;
  },
);
