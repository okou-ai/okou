import { computed } from "ccstate";

import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

/**
 * Titles of the chat threads this user's event-sourced thread list knows, by
 * thread id. A thread missing here belongs to someone else, was deleted, or
 * has not loaded yet; a null title has not been named.
 */
export const chatThreadTitlesById$ = computed((get) => {
  return new Map(
    get(eventDrivenChatThreads$).map((thread) => {
      return [thread.id, thread.title] as const;
    }),
  );
});
