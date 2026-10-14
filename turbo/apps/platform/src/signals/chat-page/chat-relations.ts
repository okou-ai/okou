import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  chatRelationsContract,
  type ChatRelationCursor,
  type ChatRelationMessage,
} from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { withCleanup } from "../utils.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

interface RelationPage<T> {
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
        const loaded = await get(data$);
        signal.throwIfAborted();
        if (!loaded.nextCursor) {
          return;
        }
        const page = await set(fetchMore$, loaded.nextCursor, signal);
        signal.throwIfAborted();
        if ((await get(first$)) !== first) {
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
  // New admissions use the run ID as the launch input ID. For older history,
  // only the very first run event may establish a source; never use a later input.
  const launch =
    events.find((event) => {
      return event.id === first.runId && event.runId === first.runId;
    }) ?? first;
  if (
    launch.eventType !== "input.prompt" &&
    launch.eventType !== "input.automation"
  ) {
    return { kind: "unknown" };
  }
  const source = launch.userMessage?.parts.find((part): part is SourcePart => {
    return part.type === "source";
  });
  return source ? { kind: "source", part: source } : { kind: "unknown" };
}

export function createChatRelationSignals(
  threadId: string,
  {
    chatEvents$: events$,
    initialEventsReady$: ready$,
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
    if (!get(ready$)) {
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
  return {
    origin$,
    children: createPaging(childrenFirst$, childrenMore$),
    communications: createPaging(communicationsFirst$, communicationsMore$),
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
