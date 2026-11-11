import { command, computed } from "ccstate";
import { chatThreadPinOrderContract } from "@okouai/api-contracts/client/chat-threads";
import { moveChatThreadPinOrder } from "@okouai/core/chat-thread-pin-order";
import { apiClient$ } from "../api-client.ts";
import { currentChatThreadList$ } from "../agent-chat.ts";
import { accept } from "../../lib/accept.ts";
import { chatThreadOnlyArchived$ } from "./chat-thread-only-archived.ts";
import { chatThreadOnlyUnread$ } from "./chat-thread-only-unread.ts";
import { chatThreadOnlyMuted$ } from "./chat-thread-only-muted.ts";
import {
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";

export const pinnedThreadReorderEnabled$ = computed((get) => {
  return (
    !get(chatThreadOnlyUnread$) &&
    !get(chatThreadOnlyArchived$) &&
    !get(chatThreadOnlyMuted$)
  );
});

interface PinMove {
  readonly threadId: string;
  readonly targetId: string;
  readonly side: "before" | "after";
  /** The Project whose chats list the pin, or null outside Projects. */
  readonly projectId: string | null;
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
    // A pin ranks against the pins listed with it: the chats of its Project,
    // which can belong to several Agents, or else the chats of its Agent.
    const ranked = threads.filter((item) => {
      return move.projectId === null
        ? item.agentId === thread.agentId
        : item.projectId === move.projectId;
    });
    const pinOrders = new Map(
      moveChatThreadPinOrder(
        ranked,
        move.threadId,
        move.targetId,
        move.side,
      ).map((update) => {
        return [update.threadId, update.pinOrder] as const;
      }),
    );
    // A move between equal ranks also re-ranks the chats tied with it, and
    // each of them keeps its own Agent.
    const reranked = ranked.flatMap((item) => {
      const pinOrder = pinOrders.get(item.id);
      return pinOrder === undefined
        ? []
        : [{ thread: item, pinOrder, eventId: crypto.randomUUID() }];
    });
    for (const update of reranked) {
      set(registerOptimisticChatThreadEvent$, {
        id: update.eventId,
        kind: "sort_touched",
        chatThreadId: update.thread.id,
        agentId: update.thread.agentId,
        pinOrder: update.pinOrder,
      });
    }
    const client = get(apiClient$)(chatThreadPinOrderContract);
    await Promise.all(
      reranked.map((update) => {
        return accept(
          client.reorder({
            params: { id: update.thread.id },
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
    const list = await get(currentChatThreadList$);
    signal.throwIfAborted();
    // A pin steps over the pins listed with it: the other chats of its
    // Project, or else the chats outside Projects.
    const projectThreads = get(list.projectThreads$);
    const projectId =
      projectThreads.find((item) => {
        return item.id === threadId;
      })?.projectId ?? null;
    const listed =
      projectId === null
        ? get(list.threads$)
        : projectThreads.filter((item) => {
            return item.projectId === projectId;
          });
    const pins = listed.filter((item) => {
      return item.pinnedAt !== null;
    });
    const index = pins.findIndex((item) => {
      return item.id === threadId;
    });
    if (index === -1) {
      return;
    }
    const target = pins[index + direction];
    if (target) {
      await set(
        movePinnedThread$,
        {
          threadId,
          targetId: target.id,
          side: direction < 0 ? "before" : "after",
          projectId,
        },
        signal,
      );
    }
  },
);
