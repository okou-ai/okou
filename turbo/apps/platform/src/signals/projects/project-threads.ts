import { computed } from "ccstate";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { createSidebarChatThreadItemSignalsRegistry } from "../chat-page/sidebar-chat-thread-item.ts";
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
