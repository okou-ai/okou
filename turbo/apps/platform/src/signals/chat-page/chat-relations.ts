import { command, computed, state, type Computed } from "ccstate";
import { chatRelationsContract } from "@okouai/api-contracts/client/chat-relations";
import type {
  ChatCommunication,
  ChatRelationMessage,
  CreatedChatRelation,
  RelatedChat,
} from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

export interface ChatRelationList<T> {
  readonly data$: Computed<Promise<{ readonly items: readonly T[] }>>;
}

function createMessages(
  threadId: string,
  peerId: string,
  revision$: Computed<unknown>,
): ChatRelationList<ChatRelationMessage> {
  const data$ = computed(async (get) => {
    get(revision$);
    return (
      await accept(
        get(apiClient$)(chatRelationsContract).messages({
          params: { id: threadId, peerId },
        }),
        [200],
      )
    ).body;
  });
  return { data$ };
}

type SourcePart = Extract<UserMessagePart, { type: "source" }>;
type ChatOrigin =
  | { readonly kind: "not-started" | "unknown" }
  | { readonly kind: "source"; readonly part: SourcePart };

function chatOrigin(events: ChatEvent[]): ChatOrigin {
  const first = events.find((event) => {
    return event.seqId !== undefined && typeof event.runId === "string";
  });
  if (!first) {
    return { kind: "not-started" };
  }
  // Admission uses the run ID as its launch input ID; later inputs are not origins.
  const launch = events.find((event) => {
    return event.id === first.runId && event.runId === first.runId;
  });
  if (
    !launch ||
    (launch.eventType !== "input.prompt" &&
      launch.eventType !== "input.automation")
  ) {
    return { kind: "unknown" };
  }
  const source = launch.userMessage?.parts.find((part): part is SourcePart => {
    return part.type === "source";
  });
  return source ? { kind: "source", part: source } : { kind: "unknown" };
}

export interface ResourceChat extends RelatedChat {
  readonly lastActivityAt: string;
  /** Messages were sent or received, so the chat has a message history. */
  readonly exchanged: boolean;
}

function createResourceChats(
  children: ChatRelationList<CreatedChatRelation>,
  communications: ChatRelationList<ChatCommunication>,
) {
  const data$ = computed(async (get) => {
    const [created, exchanged] = await Promise.allSettled([
      get(children.data$),
      get(communications.data$),
    ]);
    const chats = new Map<string, ResourceChat>();
    if (created.status === "fulfilled") {
      for (const chat of created.value.items) {
        chats.set(chat.threadId, {
          ...chat,
          lastActivityAt: chat.createdAt,
          exchanged: false,
        });
      }
    }
    if (exchanged.status === "fulfilled") {
      for (const chat of exchanged.value.items) {
        chats.set(chat.threadId, {
          ...chat,
          lastActivityAt: chat.lastMessageAt,
          exchanged: chat.sentCount + chat.receivedCount > 0,
        });
      }
    }
    return {
      items: [...chats.values()].sort((left, right) => {
        return (
          right.lastActivityAt.localeCompare(left.lastActivityAt) ||
          left.threadId.localeCompare(right.threadId)
        );
      }),
      failed: created.status === "rejected" || exchanged.status === "rejected",
    };
  });
  return { data$ };
}

// One related chat's message history is open at a time.
function createPeerMessages(threadId: string, revision$: Computed<unknown>) {
  const selectedPeer$ = state<string | null>(null);
  return {
    selectedPeer$: computed((get) => {
      return get(selectedPeer$);
    }),
    messages$: computed((get) => {
      const peerId = get(selectedPeer$);
      return peerId ? createMessages(threadId, peerId, revision$) : null;
    }),
    togglePeer$: command(({ get, set }, peerId: string) => {
      set(selectedPeer$, get(selectedPeer$) === peerId ? null : peerId);
    }),
    closeMessages$: command(({ set }) => {
      set(selectedPeer$, null);
    }),
  };
}

export function createChatRelationSignals(
  threadId: string,
  {
    chatEvents$: events$,
    initialEventsReady$,
  }: {
    readonly chatEvents$: Computed<ChatEvent[]>;
    readonly initialEventsReady$: Computed<boolean>;
  },
) {
  const eventRevision$ = computed((get) => {
    const events = get(events$);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (
        event &&
        event.seqId !== undefined &&
        (event.eventType.startsWith("input.") ||
          event.eventType.startsWith("run."))
      ) {
        return event.id;
      }
    }
    return undefined;
  });
  const revision$ = computed((get) => {
    // Creation updates the thread list; accepted inputs and run completion update this chat.
    return {
      threads: get(eventDrivenChatThreads$),
      latestEventId: get(eventRevision$),
    };
  });
  const origin$ = computed((get): ChatOrigin | null => {
    if (!get(initialEventsReady$)) {
      return null;
    }
    const events = get(events$);
    return chatOrigin(events);
  });
  const children: ChatRelationList<CreatedChatRelation> = {
    data$: computed(async (get) => {
      get(revision$);
      return (
        await accept(
          get(apiClient$)(chatRelationsContract).children({
            params: { id: threadId },
          }),
          [200],
        )
      ).body;
    }),
  };
  const communications: ChatRelationList<ChatCommunication> = {
    data$: computed(async (get) => {
      get(revision$);
      return (
        await accept(
          get(apiClient$)(chatRelationsContract).communications({
            params: { id: threadId },
          }),
          [200],
        )
      ).body;
    }),
  };
  return {
    origin$,
    chats: createResourceChats(children, communications),
    ...createPeerMessages(threadId, revision$),
  };
}
export type ChatRelationSignals = ReturnType<typeof createChatRelationSignals>;
