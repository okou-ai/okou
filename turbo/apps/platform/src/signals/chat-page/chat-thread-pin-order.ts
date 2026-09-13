import { command, computed } from "ccstate";
import { chatThreadPinOrderContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  comparePinnedThreads,
  moveChatThreadPinOrder,
} from "@okouai/core/chat-thread-pin-order";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { chatThreadOnlyUnread$ } from "./chat-thread-only-unread.ts";
import {
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";

export const pinnedThreadReorderEnabled$ = computed((get) => {
  return !get(chatThreadOnlyUnread$);
});

interface PinMove {
  readonly threadId: string;
  readonly targetId: string;
  readonly side: "before" | "after";
}

const movePinnedThread$ = command(
  async ({ get, set }, move: PinMove, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(pinnedThreadReorderEnabled$)) {
      return;
    }
    const threads = get(eventDrivenChatThreads$);
    const thread = threads.find((item) => {
      return item.id === move.threadId;
    });
    if (!thread) {
      return;
    }
    const updates = moveChatThreadPinOrder(
      threads.filter((item) => {
        return item.agentId === thread.agentId;
      }),
      move.threadId,
      move.targetId,
      move.side,
    ).map((update) => {
      return { ...update, eventId: crypto.randomUUID() };
    });
    for (const update of updates) {
      set(registerOptimisticChatThreadEvent$, {
        id: update.eventId,
        kind: "sort_touched",
        chatThreadId: update.threadId,
        agentId: thread.agentId,
        pinOrder: update.pinOrder,
      });
    }
    const client = get(apiClient$)(chatThreadPinOrderContract);
    await Promise.all(
      updates.map((update) => {
        return accept(
          client.reorder({
            params: { id: update.threadId },
            body: { pinOrder: update.pinOrder, eventId: update.eventId },
            fetchOptions: { signal },
          }),
          [204],
        );
      }),
    );
    signal.throwIfAborted();
  },
);

export const stepPinnedThread$ = command(
  async (
    { get, set },
    threadId: string,
    direction: -1 | 1,
    signal: AbortSignal,
  ) => {
    const threads = get(eventDrivenChatThreads$);
    const thread = threads.find((item) => {
      return item.id === threadId;
    });
    if (!thread) {
      return;
    }
    const pins = threads
      .filter((item) => {
        return item.agentId === thread.agentId && item.pinnedAt !== null;
      })
      .sort(comparePinnedThreads);
    const index = pins.findIndex((item) => {
      return item.id === threadId;
    });
    const target = pins[index + direction];
    if (target) {
      await set(
        movePinnedThread$,
        {
          threadId,
          targetId: target.id,
          side: direction < 0 ? "before" : "after",
        },
        signal,
      );
    }
  },
);
