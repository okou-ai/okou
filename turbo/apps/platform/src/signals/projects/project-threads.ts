import { computed } from "ccstate";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { createSidebarChatThreadItemSignalsRegistry } from "../chat-page/sidebar-chat-thread-item.ts";
import { archivedProjectIds$ } from "./project-folders.ts";
const registry$ = computed(() => {
  return createSidebarChatThreadItemSignalsRegistry();
});
export const projectThreadItems$ = computed((get) => {
  const threads = get(eventDrivenChatThreads$).filter((thread) => {
    return thread.projectId !== null;
  });
  const sorted = [...threads].sort((left, right) => {
    if (left.pinnedAt === null) {
      return right.pinnedAt === null ? 0 : 1;
    }
    if (right.pinnedAt === null) {
      return -1;
    }
    return comparePinnedThreads(left, right);
  });
  const items = get(registry$).reconcile(
    sorted.map((thread) => {
      return thread.id;
    }),
  );
  return sorted.map((thread, index) => {
    return { thread, signals: items[index]! };
  });
});

export const unreadProjectIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const archivedIds = get(archivedProjectIds$);
    const projectIds = await Promise.all(
      get(projectThreadItems$).map(async ({ thread, signals }) => {
        if (
          thread.projectId === null ||
          thread.archived !== archivedIds.has(thread.projectId)
        ) {
          return undefined;
        }
        return (await get(signals.unread$)) ? thread.projectId : undefined;
      }),
    );
    return new Set(
      projectIds.filter((id) => {
        return id !== undefined;
      }),
    );
  },
);
