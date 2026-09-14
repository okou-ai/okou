import { command, computed, state } from "ccstate";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import type { SessionOutputDelta } from "@okouai/api-contracts/contracts/realtime";
import { logger } from "../log.ts";
import type {
  OptimisticChatEvent,
  OptimisticUserMessageAssociation,
} from "./chat-event-types.ts";
import {
  chatEventDebugSummaries,
  chatEventTraceTime,
} from "./chat-event-debug.ts";

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

const L = logger("OptimisticChatEvents");

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
    const runGroupId = events.find((event) => {
      return event.runId === chunk.runId && event.runGroupId;
    })?.runGroupId;
    set(internalOptimisticChatEvents$, [
      ...entries,
      {
        threadId: chunk.threadId,
        event: {
          id: chunk.eventId,
          threadId: chunk.threadId,
          runId: chunk.runId,
          ...(runGroupId ? { runGroupId } : {}),
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

function pendingUserMessages(
  entries: readonly OptimisticChatEventEntry[],
  threadId: string,
): { eventId: string; association: OptimisticUserMessageAssociation }[] {
  return entries.flatMap((entry) => {
    const association = entry.optimisticUserMessageAssociation;
    return entry.threadId === threadId && association !== undefined
      ? [{ eventId: entry.event.id, association }]
      : [];
  });
}

export function createOptimisticChatEventsForThread(threadId: string) {
  return computed((get): OptimisticChatEventEntry[] => {
    return get(internalOptimisticChatEvents$).filter((entry) => {
      return entry.threadId === threadId;
    });
  });
}
export const appendOptimisticChatEvent$ = command(
  ({ get, set }, entry: OptimisticChatEventEntry) => {
    set(internalOptimisticChatEvents$, (prev) => {
      const next = prev.filter((item) => {
        return item.event.id !== entry.event.id;
      });
      return [...next, entry];
    });
    L.debug("optimistic event appended", {
      traceTime: chatEventTraceTime(),
      threadId: entry.threadId,
      eventId: entry.event.id,
      association: entry.optimisticUserMessageAssociation ?? null,
      pendingUserMessages: pendingUserMessages(
        get(internalOptimisticChatEvents$),
        entry.threadId,
      ),
    });
  },
);

export const reconcileOptimisticChatEvents$ = command(
  (
    { get, set },
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
    const before = pendingUserMessages(
      get(internalOptimisticChatEvents$),
      threadId,
    );
    set(internalOptimisticChatEvents$, (prev) => {
      return prev.filter((entry) => {
        return entry.threadId !== threadId || !serverIds.has(entry.event.id);
      });
    });
    const after = pendingUserMessages(
      get(internalOptimisticChatEvents$),
      threadId,
    );
    L.debug("optimistic events reconciled", {
      traceTime: chatEventTraceTime(),
      threadId,
      serverEventCount: events.length,
      // A pending user message that no server event ever matches keeps
      // `hasOptimisticUserMessage$` true, which pins the thread to the tail.
      pendingUserMessagesBefore: before,
      pendingUserMessagesAfter: after,
      serverEvents: chatEventDebugSummaries(events),
    });
  },
);
