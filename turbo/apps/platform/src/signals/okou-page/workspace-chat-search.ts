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

export const MAX_VISIBLE_SEARCH_RESULTS = 25;
const MAX_MATCHING_THREADS = 3;

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

export const threeColumnSearchChatThreads$ = computed(
  async (get): Promise<WorkspaceSearchChatThreadResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (!query) {
      const threads = await get(chatThreads$);
      return {
        query,
        chatThreads: threads
          .slice(0, MAX_VISIBLE_SEARCH_RESULTS)
          .map(workspaceSearchChatThread),
      };
    }
    const matchingThreads = [...get(workspaceSearchChatThreadMap$).values()]
      .filter((thread) => {
        return thread.title.toLowerCase().includes(query);
      })
      .sort((left, right) => {
        return (
          right.sortAt.localeCompare(left.sortAt) ||
          right.id.localeCompare(left.id)
        );
      });
    return {
      query,
      chatThreads: matchingThreads.slice(0, MAX_MATCHING_THREADS),
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
