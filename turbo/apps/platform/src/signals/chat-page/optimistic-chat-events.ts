import { command, computed, state } from "ccstate";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import type { SessionOutputDelta } from "@okouai/api-contracts/contracts/realtime";
import type {
  OptimisticChatEvent,
  OptimisticUserMessageAssociation,
} from "./chat-event-types.ts";

export interface OptimisticChatEventInput {
  threadId: string;
  event: OptimisticChatEvent;
  optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
}

export type OptimisticChatEventEntry = OptimisticChatEventInput;

export function createOptimisticChatEventEntry(
  input: OptimisticChatEventInput,
): OptimisticChatEventEntry {
  return { ...input };
}

const internalOptimisticChatEvents$ = state<OptimisticChatEventEntry[]>([]);

export const appendOptimisticSessionOutput$ = command(
  (
    { get, set },
    chunk: SessionOutputDelta,
    events: readonly ChatEvent[],
  ): boolean => {
    if (
      events.some((event) => {
        return event.id === chunk.eventId;
      })
    ) {
      return false;
    }
    const entries = get(internalOptimisticChatEvents$);
    const existing = entries.find((entry) => {
      return (
        entry.threadId === chunk.threadId && entry.event.id === chunk.eventId
      );
    });
    if (existing) {
      if (
        existing.event.eventType !== "output.message" ||
        existing.event.runId !== chunk.runId ||
        chunk.chunkIndex === 0
      ) {
        return false;
      }
      set(
        internalOptimisticChatEvents$,
        entries.map((entry) => {
          return entry === existing
            ? {
                ...entry,
                event: {
                  ...existing.event,
                  content: existing.event.content + chunk.delta,
                },
              }
            : entry;
        }),
      );
      return true;
    }
    if (chunk.chunkIndex !== 0) {
      return false;
    }
    set(internalOptimisticChatEvents$, [
      ...entries,
      {
        threadId: chunk.threadId,
        event: {
          id: chunk.eventId,
          threadId: chunk.threadId,
          runId: chunk.runId,
          runEventId: chunk.runEventId,
          eventType: "output.message",
          content: chunk.delta,
          createdAt: chunk.createdAt,
        },
      },
    ]);
    return true;
  },
);

/**
 * Every event the page projected locally and no persistent event has replaced
 * yet. Event ids are unique across threads, so a view can ask about one message
 * without knowing which thread buffered it.
 */
export const optimisticEventIds$ = computed((get): ReadonlySet<string> => {
  return new Set(
    get(internalOptimisticChatEvents$).map((entry) => {
      return entry.event.id;
    }),
  );
});

export function createOptimisticChatEventsForThread(threadId: string) {
  return computed((get): OptimisticChatEventEntry[] => {
    return get(internalOptimisticChatEvents$).filter((entry) => {
      return entry.threadId === threadId;
    });
  });
}
export const appendOptimisticChatEvent$ = command(
  ({ set }, entry: OptimisticChatEventEntry) => {
    set(internalOptimisticChatEvents$, (prev) => {
      const next = prev.filter((item) => {
        return item.event.id !== entry.event.id;
      });
      return [...next, entry];
    });
  },
);

export const reconcileOptimisticChatEvents$ = command(
  (
    { set },
    { threadId, events }: { threadId: string; events: readonly ChatEvent[] },
  ) => {
    if (events.length === 0) {
      return;
    }
    const serverIds = new Set(
      events.map((event) => {
        return event.id;
      }),
    );
    set(internalOptimisticChatEvents$, (prev) => {
      return prev.filter((entry) => {
        return entry.threadId !== threadId || !serverIds.has(entry.event.id);
      });
    });
  },
);
