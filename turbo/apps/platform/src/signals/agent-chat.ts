import { command, computed, state, type Computed } from "ccstate";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentById, currentAgentId$, defaultAgentId$ } from "./agent.ts";
import { apiClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { reloadChatIndicatorsCounter$ } from "./chat-thread-list-reload.ts";
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
  readonly hasHiddenArchivedThreads$: Computed<boolean>;
}

interface ChatThreadListFilter {
  readonly archiveEnabled: boolean;
  readonly showArchived: boolean;
  readonly unreadOnly: boolean;
  readonly unreadThreadIds: ReadonlySet<string> | null;
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
    const threads = get(agentThreads$).filter((thread) => {
      const unread = filter.unreadThreadIds?.has(thread.id) ?? false;
      if (filter.unreadOnly) {
        return unread;
      }
      return !(
        filter.archiveEnabled &&
        !filter.showArchived &&
        isChatThreadArchived(thread.title) &&
        !unread
      );
    });
    return threads.sort((left, right) => {
      if (left.pinnedAt === null) {
        return right.pinnedAt === null ? 0 : 1;
      }
      if (right.pinnedAt === null) {
        return -1;
      }
      return comparePinnedThreads(left, right);
    });
  });

  return {
    threads$,
    threadIds$: computed((get): readonly string[] => {
      return get(threads$).map((thread) => {
        return thread.id;
      });
    }),
    hasHiddenArchivedThreads$: computed((get): boolean => {
      if (!filter.archiveEnabled || filter.showArchived) {
        return false;
      }
      return get(agentThreads$).some((thread) => {
        return (
          isChatThreadArchived(thread.title) &&
          !(filter.unreadThreadIds?.has(thread.id) ?? false)
        );
      });
    }),
  };
}

// Resolve the agent/filter query once, then keep event projection synchronous.
// Thread events can update the returned signals without replacing this Promise.
export const currentChatThreadListSignals$ = computed(
  async (get): Promise<ChatThreadListSignals> => {
    const unreadOnly = get(chatThreadOnlyUnread$);
    const archiveEnabled =
      get(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] ?? false;
    const showArchived = archiveEnabled && get(chatThreadShowArchived$);
    const needsUnreadThreads = unreadOnly || (archiveEnabled && !showArchived);
    if (needsUnreadThreads) {
      get(reloadChatIndicatorsCounter$);
    }

    const agentId = get(currentChatAgentScope$) ?? (await get(defaultAgentId$));
    let unreadThreadIds: ReadonlySet<string> | null = null;
    if (needsUnreadThreads && agentId) {
      const client = get(apiClient$)(chatThreadsContract);
      const result = await accept(
        client.unreads({ query: { agentId } }),
        [200],
      );
      unreadThreadIds = new Set(
        result.body.unreads.map((unread) => {
          return unread.threadId;
        }),
      );
    }

    return createChatThreadListSignals(agentId, {
      archiveEnabled,
      showArchived,
      unreadOnly,
      unreadThreadIds,
    });
  },
);

export const chatThreads$ = computed(
  async (get): Promise<EventDrivenChatThread[]> => {
    const list = await get(currentChatThreadListSignals$);
    return get(list.threads$);
  },
);

export const currentChatThreadListIds$ = computed(
  async (get): Promise<readonly string[]> => {
    const list = await get(currentChatThreadListSignals$);
    return get(list.threadIds$);
  },
);
