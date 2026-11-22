import { apiClient$ } from "../api-client.ts";
import { chatThreads$ } from "../chat-thread-list.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { chatListQuery$, debouncedChatListQuery$ } from "./sidebar-state.ts";
import { computed } from "ccstate";
import { chatSearchContract } from "@okouai/api-contracts/client/chat-threads";
import type { ChatSearchResult } from "@okouai/api-contracts/contracts/chat-threads";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";

const MAX_VISIBLE_CHAT_THREAD_RESULTS = 25;

export interface WorkspaceSearchChatThread {
  readonly id: string;
  readonly title: string;
  readonly sortAt: string;
}

interface WorkspaceSearchChatThreadResult {
  readonly query: string;
  readonly chatThreads: readonly WorkspaceSearchChatThread[];
}

interface WorkspaceSearchChatMessageResult {
  readonly query: string;
  readonly chatMessages: readonly ChatSearchResult[];
}

function workspaceSearchChatThread(
  thread: EventDrivenChatThread,
): WorkspaceSearchChatThread {
  return {
    id: thread.id,
    title:
      thread.title ??
      i18n.t(($) => {
        return $.chat.newChat;
      }),
    sortAt: thread.sortAt,
  };
}

export const workspaceSearchChatThreadMap$ = computed((get) => {
  return new Map(
    get(eventDrivenChatThreads$).map((thread) => {
      const result = workspaceSearchChatThread(thread);
      return [result.id, result] as const;
    }),
  );
});

export const workspaceSearchChatThreads$ = computed(
  (get): WorkspaceSearchChatThreadResult => {
    const query = get(chatListQuery$).trim().toLowerCase();
    const threads = [...get(workspaceSearchChatThreadMap$).values()];
    const matchingThreads: WorkspaceSearchChatThread[] = [];
    for (const thread of threads) {
      if (query && !thread.title.toLowerCase().includes(query)) {
        continue;
      }
      matchingThreads.push(thread);
    }
    if (query) {
      matchingThreads.sort((left, right) => {
        return (
          right.sortAt.localeCompare(left.sortAt) ||
          right.id.localeCompare(left.id)
        );
      });
    }
    return {
      query,
      chatThreads: matchingThreads.slice(0, MAX_VISIBLE_CHAT_THREAD_RESULTS),
    };
  },
);

export const threeColumnSearchChatThreads$ = computed(
  async (get): Promise<WorkspaceSearchChatThreadResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (query) {
      return get(workspaceSearchChatThreads$);
    }
    const threads = await get(chatThreads$);
    return {
      query,
      chatThreads: threads
        .slice(0, MAX_VISIBLE_CHAT_THREAD_RESULTS)
        .map(workspaceSearchChatThread),
    };
  },
);

export const workspaceSearchChatMessages$ = computed(
  async (get): Promise<WorkspaceSearchChatMessageResult> => {
    const query = await get(debouncedChatListQuery$);
    if (!query) {
      return { query, chatMessages: [] };
    }
    const client = get(apiClient$)(chatSearchContract);
    const result = await accept(
      client.search({
        query: {
          keyword: query,
        },
      }),
      [200],
    );
    return { query, chatMessages: result.body.results };
  },
);
