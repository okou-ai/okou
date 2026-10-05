import { command, computed, state } from "ccstate";
import {
  currentChatAgentScope$,
  currentChatThreadId$,
  currentChatThreadListSignals$,
  unreadChatThreads$,
  type ChatThreadListSignals,
} from "../agent-chat.ts";
import { sortedAgents$ } from "../agent.ts";
import { chatThreadOnlyArchived$ } from "../chat-page/chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "../chat-page/chat-thread-only-muted.ts";
import { chatThreadOnlyUnread$ } from "../chat-page/chat-thread-only-unread.ts";
import { createSidebarChatThreadScrollSignals } from "../chat-page/sidebar-chat-thread-scroll.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { rankAgentsForSearch } from "./workspace-chat-search.ts";

// A 56px touch row and its 4px gutter share one virtual geometry.
export const PWA_CHAT_THREAD_ROW_HEIGHT = 60;

const noHiddenArchivedThreads$ = computed(() => {
  return false;
});

const pwaChatThreadListSource$ = computed(
  async (get): Promise<ChatThreadListSignals> => {
    if (!get(chatThreadOnlyUnread$)) {
      return await get(currentChatThreadListSignals$);
    }

    const threads = await get(unreadChatThreads$);
    const threadIds = threads.map((thread) => {
      return thread.id;
    });
    const threadIds$ = computed(() => {
      return threadIds;
    });

    return {
      threads$: computed(() => {
        return threads;
      }),
      allThreadIds$: threadIds$,
      threadIds$,
      count$: computed(() => {
        return threadIds.length;
      }),
      currentThreadListed$: computed((get): boolean => {
        const threadId = get(currentChatThreadId$);
        return threadId !== null && threadIds.includes(threadId);
      }),
      hasHiddenArchivedThreads$: noHiddenArchivedThreads$,
    };
  },
);

export const pwaChatThreadScrollSignals$ = computed((get) => {
  // Returning from a conversation retains this graph and its scroll position.
  // A different agent or filter starts a new list at the top.
  get(currentChatAgentScope$);
  get(chatThreadOnlyUnread$);
  get(chatThreadOnlyArchived$);
  get(chatThreadOnlyMuted$);
  return createSidebarChatThreadScrollSignals({
    source$: pwaChatThreadListSource$,
    rowHeight: PWA_CHAT_THREAD_ROW_HEIGHT,
    restoreScrollPosition: true,
  });
});

const internalAgentSwitcherOpen$ = state(false);
const internalAgentQuery$ = state("");

export const pwaAgentSwitcherOpen$ = computed((get) => {
  return get(internalAgentSwitcherOpen$);
});

export const pwaAgentQuery$ = computed((get) => {
  return get(internalAgentQuery$);
});

export const setPwaAgentSwitcherOpen$ = command(({ set }, open: boolean) => {
  set(internalAgentSwitcherOpen$, open);
  if (!open) {
    set(internalAgentQuery$, "");
  }
});

export const setPwaAgentQuery$ = command(({ set }, query: string) => {
  set(internalAgentQuery$, query);
});

export const pwaAgentOptions$ = computed(async (get) => {
  const agents = await get(sortedAgents$);
  const query = get(internalAgentQuery$).trim().toLowerCase();
  return query ? rankAgentsForSearch(agents, query) : agents;
});

export const selectPwaAgent$ = command(({ set }, agentId: string) => {
  set(setPwaAgentSwitcherOpen$, false);
  set(detachedNavigateTo$, "/agents/:agentId/chat", {
    pathParams: { agentId },
  });
});
