import { command, computed, state, type Computed } from "ccstate";
import {
  chatRelationsContract,
  type ChatRelationMessage,
  type ChatCommunication,
  type CreatedChatRelation,
  type RelatedChat,
} from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
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
}

function createResourceChats(
  children: ChatRelationList<CreatedChatRelation>,
  communications: ChatRelationList<ChatCommunication>,
) {
  const data$ = computed(async (get) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel]) {
      return { items: [], failed: false };
    }
    const [created, exchanged] = await Promise.allSettled([
      get(children.data$),
      get(communications.data$),
    ]);
    const chats = new Map<string, ResourceChat>();
    if (created.status === "fulfilled") {
      for (const chat of created.value.items) {
        chats.set(chat.threadId, { ...chat, lastActivityAt: chat.createdAt });
      }
    }
    if (exchanged.status === "fulfilled") {
      for (const chat of exchanged.value.items) {
        chats.set(chat.threadId, {
          ...chat,
          lastActivityAt: chat.lastMessageAt,
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

function createPeerMessages(threadId: string, revision$: Computed<unknown>) {
  const selectedPeer$ = state<string | null>(null);
  const emptyPeers$ = state<{
    readonly revision: unknown;
    readonly ids: readonly string[];
  } | null>(null);
  const confirmedEmptyPeers$ = computed((get) => {
    const empty = get(emptyPeers$);
    return empty && empty.revision === get(revision$) ? empty.ids : [];
  });
  const messages$ = computed((get) => {
    const peerId = get(selectedPeer$);
    return peerId ? createMessages(threadId, peerId, revision$) : null;
  });
  return {
    selectedPeer$: computed((get) => {
      return get(selectedPeer$);
    }),
    messages$,
    closeMessages$: command(({ set }) => {
      set(selectedPeer$, null);
    }),
    confirmedEmptyPeers$,
    togglePeer$: command(
      async (
        { get, set },
        peerId: string,
        trigger: HTMLElement,
        signal: AbortSignal,
      ) => {
        if (get(selectedPeer$) === peerId) {
          set(selectedPeer$, null);
          return;
        }
        set(selectedPeer$, peerId);
        const revision = get(revision$);
        const list = get(messages$);
        if (!list) {
          return;
        }
        const page = await get(list.data$);
        signal.throwIfAborted();
        if (revision === get(revision$) && page.items.length === 0) {
          if (document.activeElement === trigger) {
            // The confirmed-empty toggle disappears; keep keyboard focus on its chat.
            trigger.parentElement
              ?.querySelector<HTMLElement>("a")
              ?.focus({ preventScroll: true });
          }
          set(emptyPeers$, {
            revision,
            ids: [...get(confirmedEmptyPeers$), peerId],
          });
        }
      },
    ),
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
  const retryRevision$ = state(0);
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
      retry: get(retryRevision$),
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
    retry$: command(({ set }) => {
      set(retryRevision$, (value) => {
        return value + 1;
      });
    }),
  };
}
export type ChatRelationSignals = ReturnType<typeof createChatRelationSignals>;
