import { computed } from "ccstate";

import { chatThreadIndicatorsFromWorker$ } from "../shared-database.ts";
import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

export const hasUnreadChats$ = computed(async (get) => {
  const indicators = await get(chatThreadIndicatorsFromWorker$);
  const metadata = new Map(
    get(eventDrivenChatThreads$).map((thread) => [thread.id, thread] as const),
  );
  return Object.entries(indicators.threads).some(([id, indicator]) => {
    const thread = metadata.get(id);
    return indicator === "unread" && !thread?.muted && !thread?.archived;
  });
});

export const hasMarkableUnreadChats$ = computed(async (get) => {
  const indicators = await get(chatThreadIndicatorsFromWorker$);
  return get(eventDrivenChatThreads$).some(
    (thread) => !thread.muted && indicators.threads[thread.id] === "unread",
  );
});

export const sidebarActiveThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicatorsFromWorker$);
    return new Set(
      Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
        return indicator === "active" ? [threadId] : [];
      }),
    );
  },
);
