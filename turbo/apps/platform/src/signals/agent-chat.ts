import { command, computed, state, type Computed } from "ccstate";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentById, currentAgentId$, defaultAgentId$ } from "./agent.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { chatThreadIndicatorsFromWorker$ } from "./shared-database.ts";
import { chatThreadOnlyUnread$ } from "./chat-page/chat-thread-only-unread.ts";
import { chatThreadShowArchived$ } from "./chat-page/chat-thread-show-archived.ts";
import { isChatThreadArchived } from "./chat-page/chat-thread-title.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import {
  chatThreadMetaMap$,
  eventDrivenChatThreads$,
} from "./chat-page/chat-thread-event-sourcing.ts";

const internalChatAgentId$ = state<string | null>(null);

export const setChatAgentId$ = command(({ set }, agentId: string | null) => {
  set(internalChatAgentId$, agentId);
});

export const currentChatThreadId$ = computed((get): string | null => {
  const params = get(pathParams$);
  const threadId = params?.threadId;
  const route = get(activeRoute$);
  if (route !== "chat") {
    return null;
  }
  return typeof threadId === "string" ? threadId : null;
});

const currentChatThreadAgentId$ = computed((get): string | null => {
  const threadId = get(currentChatThreadId$);
  if (!threadId) {
    return null;
  }
  return get(chatThreadMetaMap$).get(threadId)?.agentId ?? null;
});

export const currentChatAgentScope$ = computed((get): string | null => {
  return (
    get(currentChatThreadAgentId$) ??
    get(internalChatAgentId$) ??
    get(currentAgentId$)
  );
});

export const currentChatAgentId$ = computed(
  async (get): Promise<string | null> => {
    return (
      (await get(currentChatThreadAgentId$)) ??
      get(internalChatAgentId$) ??
      get(currentAgentId$) ??
      (await get(defaultAgentId$))
    );
  },
);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const currentChatAgentRecordId$ = computed(
  async (get): Promise<string | null> => {
    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return null;
    }

    if (uuidPattern.test(agentId)) {
      return agentId;
    }

    return (await get(agentById(agentId))).agentId;
  },
);

export const currentChatAgent$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return null;
  }

  return await get(agentById(agentId));
});

export const currentChatAgentDisplayName$ = computed(async (get) => {
  return (await get(currentChatAgent$))?.displayName;
});

export interface ChatThreadListSignals {
  readonly threads$: Computed<EventDrivenChatThread[]>;
  readonly threadIds$: Computed<readonly string[]>;
  readonly count$: Computed<number>;
  readonly currentThreadListed$: Computed<boolean>;
  readonly hasHiddenArchivedThreads$: Computed<boolean>;
}

interface ChatThreadListFilter {
  readonly archiveEnabled: boolean;
  readonly showArchived: boolean;
}

function sortChatThreads(threads: EventDrivenChatThread[]) {
  return threads.sort((left, right) => {
    if (left.pinnedAt === null) {
      return right.pinnedAt === null ? 0 : 1;
    }
    if (right.pinnedAt === null) {
      return -1;
    }
    return comparePinnedThreads(left, right);
  });
}

function createChatThreadListSignals(
  agentId: string | null,
  filter: ChatThreadListFilter,
): ChatThreadListSignals {
  const agentThreads$ = computed((get): EventDrivenChatThread[] => {
    if (!agentId) {
      return [];
    }
    return get(eventDrivenChatThreads$).filter((thread) => {
      return thread.agentId === agentId;
    });
  });
  const threads$ = computed((get): EventDrivenChatThread[] => {
    const currentThreadId = get(currentChatThreadId$);
    const threads = get(agentThreads$).filter((thread) => {
      const hiddenArchived =
        filter.archiveEnabled &&
        !filter.showArchived &&
        isChatThreadArchived(thread.title);
      return !hiddenArchived || thread.id === currentThreadId;
    });
    return sortChatThreads(threads);
  });
  const threadIds$ = computed((get): readonly string[] => {
    return get(threads$).map((thread) => {
      return thread.id;
    });
  });

  return {
    threads$,
    threadIds$,
    count$: computed((get): number => {
      return get(threadIds$).length;
    }),
    currentThreadListed$: computed((get): boolean => {
      const threadId = get(currentChatThreadId$);
      return threadId ? get(threadIds$).includes(threadId) : false;
    }),
    hasHiddenArchivedThreads$: computed((get): boolean => {
      if (!filter.archiveEnabled || filter.showArchived) {
        return false;
      }
      const currentThreadId = get(currentChatThreadId$);
      return get(agentThreads$).some((thread) => {
        return (
          thread.id !== currentThreadId && isChatThreadArchived(thread.title)
        );
      });
    }),
  };
}

// Resolve the agent/filter query once, then keep event projection synchronous.
// Thread events can update the returned signals without replacing this Promise.
export const currentChatThreadListSignals$ = computed(
  async (get): Promise<ChatThreadListSignals> => {
    const archiveEnabled =
      get(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] ?? false;
    const showArchived = archiveEnabled && get(chatThreadShowArchived$);

    const agentId = get(currentChatAgentScope$) ?? (await get(defaultAgentId$));

    return createChatThreadListSignals(agentId, {
      archiveEnabled,
      showArchived,
    });
  },
);

// Indicators bound the unread list. Keep their asynchronous dependency out of
// the all-chats projection and its synchronous virtual window.
export const unreadChatThreads$ = computed(
  async (get): Promise<EventDrivenChatThread[]> => {
    const agentId = await get(currentChatAgentId$);
    if (!agentId) {
      return [];
    }
    const indicators = await get(chatThreadIndicatorsFromWorker$);
    const archiveEnabled =
      get(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] ?? false;
    const showArchived = archiveEnabled && get(chatThreadShowArchived$);
    const threads = get(eventDrivenChatThreads$).filter((thread) => {
      return (
        thread.agentId === agentId &&
        indicators.threads[thread.id] === "unread" &&
        (!archiveEnabled || showArchived || !isChatThreadArchived(thread.title))
      );
    });
    return sortChatThreads(threads);
  },
);

export const chatThreads$ = computed(
  async (get): Promise<EventDrivenChatThread[]> => {
    if (get(chatThreadOnlyUnread$)) {
      return await get(unreadChatThreads$);
    }
    const list = await get(currentChatThreadListSignals$);
    return get(list.threads$);
  },
);

export const currentChatThreadListIds$ = computed(
  async (get): Promise<readonly string[]> => {
    return (await get(chatThreads$)).map((thread) => {
      return thread.id;
    });
  },
);
