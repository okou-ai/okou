import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  chatRelationsContract,
  type ChatRelationCursor,
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
import { withCleanup } from "../utils.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

export interface RelationPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: ChatRelationCursor | null;
}
export interface ChatRelationList<T> {
  readonly data$: Computed<Promise<RelationPage<T>>>;
  readonly more$: Command<Promise<void>, [AbortSignal]>;
}

function createPaging<T>(
  first$: Computed<Promise<RelationPage<T>>>,
  fetchMore$: Command<
    Promise<RelationPage<T>>,
    [ChatRelationCursor, AbortSignal]
  >,
): ChatRelationList<T> {
  const extra$ = state<{
    readonly first: RelationPage<T>;
    readonly pages: readonly RelationPage<T>[];
  } | null>(null);
  const loadingMore$ = state(false);
  const data$ = computed(async (get): Promise<RelationPage<T>> => {
    const first = await get(first$);
    const extra = get(extra$);
    const pages = extra?.first === first ? extra.pages : [];
    return {
      items: [
        ...first.items,
        ...pages.flatMap((page) => {
          return page.items;
        }),
      ],
      nextCursor: (pages.at(-1) ?? first).nextCursor,
    };
  });
  const more$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (get(loadingMore$)) {
      return;
    }
    set(loadingMore$, true);
    await withCleanup(
      (async () => {
        const first = await get(first$);
        signal.throwIfAborted();
        const loaded = await get(data$);
        signal.throwIfAborted();
        if (!loaded.nextCursor) {
          return;
        }
        const page = await set(fetchMore$, loaded.nextCursor, signal);
        signal.throwIfAborted();
        const currentFirst = await get(first$);
        signal.throwIfAborted();
        if (currentFirst !== first) {
          return;
        }
        set(extra$, (previous) => {
          return {
            first,
            pages: [...(previous?.first === first ? previous.pages : []), page],
          };
        });
      })(),
      () => {
        set(loadingMore$, false);
      },
    );
  });
  return { data$, more$ };
}
function cursorQuery(cursor: ChatRelationCursor) {
  return { before: cursor.createdAt, beforeId: cursor.id };
}

function createMessages(
  threadId: string,
  peerId: string,
  revision$: Computed<unknown>,
): ChatRelationList<ChatRelationMessage> {
  const first$ = computed(async (get) => {
    get(revision$);
    return (
      await accept(
        get(apiClient$)(chatRelationsContract).messages({
          params: { id: threadId, peerId },
          query: { limit: 20 },
        }),
        [200],
      )
    ).body;
  });
  const more$ = command(
    async ({ get }, cursor: ChatRelationCursor, signal: AbortSignal) => {
      return (
        await accept(
          get(apiClient$)(chatRelationsContract).messages({
            params: { id: threadId, peerId },
            query: { limit: 20, ...cursorQuery(cursor) },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        )
      ).body;
    },
  );
  return createPaging(first$, more$);
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

function createRelationContentSignal(
  origin$: Computed<ChatOrigin | null>,
  lists: readonly ChatRelationList<unknown>[],
) {
  return computed(async (get) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.ChatRelations]) {
      return false;
    }
    const origin = get(origin$);
    if (origin === null) {
      return null;
    }
    if (origin.kind === "source") {
      return true;
    }
    // Failed lists are settled too: their views retain the error and retry UI.
    const results = await Promise.allSettled(
      lists.map((list) => {
        return get(list.data$);
      }),
    );
    return results.some((result) => {
      return result.status === "rejected" || result.value.items.length > 0;
    });
  });
}

export interface ResourceChat extends RelatedChat {
  readonly lastActivityAt: string;
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
      hasMore: [created, exchanged].some((result) => {
        return (
          result.status === "fulfilled" && result.value.nextCursor !== null
        );
      }),
      failed: created.status === "rejected" || exchanged.status === "rejected",
    };
  });
  const more$ = command(async ({ get, set }, signal: AbortSignal) => {
    // Page both sources independently; one failing list must not hide the other.
    const lists: readonly ChatRelationList<unknown>[] = [
      children,
      communications,
    ];
    const results = await Promise.allSettled(
      lists.map(async (list) => {
        const page = await get(list.data$);
        signal.throwIfAborted();
        if (page.nextCursor) {
          await set(list.more$, signal);
        }
      }),
    );
    signal.throwIfAborted();
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  });
  return { data$, more$ };
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
  const refresh$ = state(0);
  const selectedPeer$ = state<string | null>(null);
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
      refresh: get(refresh$),
    };
  });
  const origin$ = computed((get): ChatOrigin | null => {
    if (!get(initialEventsReady$)) {
      return null;
    }
    const events = get(events$);
    return chatOrigin(events);
  });
  const childrenFirst$ = computed(async (get) => {
    get(revision$);
    return (
      await accept(
        get(apiClient$)(chatRelationsContract).children({
          params: { id: threadId },
          query: { limit: 5 },
        }),
        [200],
      )
    ).body;
  });
  const childrenMore$ = command(
    async ({ get }, cursor: ChatRelationCursor, signal: AbortSignal) => {
      return (
        await accept(
          get(apiClient$)(chatRelationsContract).children({
            params: { id: threadId },
            query: { limit: 5, ...cursorQuery(cursor) },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        )
      ).body;
    },
  );
  const communicationsFirst$ = computed(async (get) => {
    get(revision$);
    return (
      await accept(
        get(apiClient$)(chatRelationsContract).communications({
          params: { id: threadId },
          query: { limit: 5 },
        }),
        [200],
      )
    ).body;
  });
  const communicationsMore$ = command(
    async ({ get }, cursor: ChatRelationCursor, signal: AbortSignal) => {
      return (
        await accept(
          get(apiClient$)(chatRelationsContract).communications({
            params: { id: threadId },
            query: { limit: 5, ...cursorQuery(cursor) },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        )
      ).body;
    },
  );
  const messages$ = computed((get) => {
    const peerId = get(selectedPeer$);
    return peerId ? createMessages(threadId, peerId, revision$) : null;
  });
  const children = createPaging(childrenFirst$, childrenMore$);
  const communications = createPaging(
    communicationsFirst$,
    communicationsMore$,
  );
  return {
    origin$,
    hasContent$: createRelationContentSignal(origin$, [
      children,
      communications,
    ]),
    chats: createResourceChats(children, communications),
    selectedPeer$: computed((get) => {
      return get(selectedPeer$);
    }),
    messages$,
    togglePeer$: command(({ get, set }, peerId: string) => {
      set(selectedPeer$, get(selectedPeer$) === peerId ? null : peerId);
    }),
    reload$: command(({ set }) => {
      set(refresh$, (value) => {
        return value + 1;
      });
    }),
  };
}
export type ChatRelationSignals = ReturnType<typeof createChatRelationSignals>;
