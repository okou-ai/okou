import { singleAgentEnabled$ } from "./single-agent.ts";
import { command, computed, state, type Computed } from "ccstate";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentById, currentAgentId$, defaultAgentId$ } from "./agent.ts";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { chatThreadIndicatorsFromWorker$ } from "./shared-database.ts";
import { chatThreadOnlyUnread$ } from "./chat-page/chat-thread-only-unread.ts";
import { chatThreadOnlyArchived$ } from "./chat-page/chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "./chat-page/chat-thread-only-muted.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import {
  chatThreadMetaMap$,
  eventDrivenChatThreads$,
} from "./chat-page/chat-thread-event-sourcing.ts";
import {
  buildChatThreadListRows,
  buildChatThreadNavigationList,
  threadRowKey,
  type ChatThreadListRow,
  type ChatThreadNavigationList,
} from "./chat-page/chat-thread-list-rows.ts";
import { projects$ } from "./projects/projects.ts";
import {
  expandedProjectIds$,
  projectThreadLimits$,
} from "./projects/project-expansion.ts";

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

export const hasCurrentChatThread$ = computed((get): boolean => {
  return get(currentChatThreadId$) !== null;
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

/** Fresh enabled chats always use the default executor; existing threads keep theirs. */
export const newChatAgentId$ = computed(async (get) => {
  return get(singleAgentEnabled$)
    ? await get(defaultAgentId$)
    : await get(currentChatAgentId$);
});

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

export const currentChatAgentDisplayName$ = computed(
  async (get): Promise<string | null> => {
    if (
      get(singleAgentEnabled$) &&
      (await get(currentChatAgentId$)) === (await get(defaultAgentId$))
    ) {
      return "Okou";
    }
    // A missing agent and a missing name both mean "no display name".
    return (await get(currentChatAgent$))?.displayName ?? null;
  },
);

export interface ChatThreadListSignals {
  /** Listed chats outside Projects, which own number shortcuts and pins. */
  readonly threads$: Computed<EventDrivenChatThread[]>;
  readonly threadIds$: Computed<readonly string[]>;
  readonly rows$: Computed<readonly ChatThreadListRow[]>;
  readonly navigation$: Computed<ChatThreadNavigationList>;
  readonly count$: Computed<number>;
  readonly currentThreadListed$: Computed<boolean>;
  readonly hasHiddenArchivedThreads$: Computed<boolean>;
}

interface ChatThreadListFilter {
  readonly archiveEnabled: boolean;
  readonly onlyArchived: boolean;
  readonly onlyMuted: boolean;
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

function threadIdsOf(threads: readonly EventDrivenChatThread[]) {
  return threads.map((thread) => {
    return thread.id;
  });
}

const projectsListed$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.Projects] === true;
});

// Projects collect chats across Agents, so every Agent list shows them.
const allProjectThreads$ = computed((get): EventDrivenChatThread[] => {
  if (!get(projectsListed$)) {
    return [];
  }
  return sortChatThreads(
    get(eventDrivenChatThreads$).filter((thread) => {
      return thread.projectId !== null;
    }),
  );
});

function createChatThreadListView({
  threads$,
  allThreadIds$,
  projectThreads$,
  allProjectThreads$: allProjectThreadsSource$,
  hideEmptyProjects,
  hasHiddenArchivedThreads$,
}: {
  threads$: Computed<EventDrivenChatThread[]>;
  allThreadIds$: Computed<readonly string[]>;
  projectThreads$: Computed<readonly EventDrivenChatThread[]>;
  allProjectThreads$: Computed<readonly EventDrivenChatThread[]>;
  hideEmptyProjects: boolean;
  hasHiddenArchivedThreads$: Computed<boolean>;
}): ChatThreadListSignals {
  const threadIds$ = computed((get): readonly string[] => {
    return threadIdsOf(get(threads$));
  });
  const rows$ = computed((get): readonly ChatThreadListRow[] => {
    return buildChatThreadListRows({
      projects: get(projects$),
      expandedProjectIds: get(expandedProjectIds$),
      projectThreadLimits: get(projectThreadLimits$),
      projectThreads: get(projectThreads$),
      threadIds: get(threadIds$),
      hideEmptyProjects,
    });
  });
  const navigation$ = computed((get): ChatThreadNavigationList => {
    return buildChatThreadNavigationList({
      projects: get(projects$),
      rows: get(rows$),
      allProjectThreads: get(allProjectThreadsSource$),
      allThreadIds: get(allThreadIds$),
    });
  });

  return {
    threads$,
    threadIds$,
    rows$,
    navigation$,
    count$: computed((get): number => {
      return get(rows$).length;
    }),
    currentThreadListed$: computed((get): boolean => {
      const threadId = get(currentChatThreadId$);
      return threadId
        ? get(navigation$).listedKeys.includes(threadRowKey(threadId))
        : false;
    }),
    hasHiddenArchivedThreads$,
  };
}

function createChatThreadListSignals(
  agentId: string | null,
  filter: ChatThreadListFilter,
): ChatThreadListSignals {
  const allThreads$ = computed((get): EventDrivenChatThread[] => {
    if (!agentId) {
      return [];
    }
    const projectsListed = get(projectsListed$);
    return sortChatThreads(
      get(eventDrivenChatThreads$).filter((thread) => {
        return (
          thread.agentId === agentId &&
          (!projectsListed || thread.projectId === null)
        );
      }),
    );
  });
  const listed = (thread: EventDrivenChatThread) => {
    if (filter.onlyMuted) {
      return thread.muted;
    }
    if (!filter.archiveEnabled) {
      return true;
    }
    return filter.onlyArchived ? thread.archived : !thread.archived;
  };

  return createChatThreadListView({
    threads$: computed((get): EventDrivenChatThread[] => {
      return get(allThreads$).filter(listed);
    }),
    allThreadIds$: computed((get): readonly string[] => {
      return threadIdsOf(get(allThreads$));
    }),
    // A filter applies to the chats inside Projects as it does to the rest.
    projectThreads$: computed((get): readonly EventDrivenChatThread[] => {
      return get(allProjectThreads$).filter(listed);
    }),
    allProjectThreads$,
    hideEmptyProjects: filter.onlyArchived || filter.onlyMuted,
    hasHiddenArchivedThreads$: computed((get): boolean => {
      if (!filter.archiveEnabled || filter.onlyArchived || filter.onlyMuted) {
        return false;
      }
      return get(allThreads$).some((thread) => {
        return thread.archived;
      });
    }),
  });
}

// Resolve the agent/filter query once, then keep event projection synchronous.
// Thread events can update the returned signals without replacing this Promise.
const currentChatThreadListSignals$ = computed(
  async (get): Promise<ChatThreadListSignals> => {
    const archiveEnabled =
      get(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] ?? false;
    const onlyArchived = archiveEnabled && get(chatThreadOnlyArchived$);

    const agentId = get(currentChatAgentScope$) ?? (await get(defaultAgentId$));

    return createChatThreadListSignals(agentId, {
      archiveEnabled,
      onlyArchived,
      onlyMuted: get(chatThreadOnlyMuted$),
    });
  },
);

const noHiddenArchivedThreads$ = computed(() => {
  return false;
});

// Indicators bound the unread list. Keep their asynchronous dependency out of
// the all-chats projection and its synchronous virtual window.
// The Unread filter always includes archived threads, so an archived thread
// never hides an unread message.
export const unreadChatThreadListSignals$ = computed(
  async (get): Promise<ChatThreadListSignals> => {
    const agentId = await get(currentChatAgentId$);
    const indicators = await get(chatThreadIndicatorsFromWorker$);
    const projectsListed = get(projectsListed$);
    const unread = get(eventDrivenChatThreads$).filter((thread) => {
      return indicators.threads[thread.id] === "unread";
    });
    const threads = agentId
      ? sortChatThreads(
          unread.filter((thread) => {
            return (
              thread.agentId === agentId &&
              (!projectsListed || thread.projectId === null)
            );
          }),
        )
      : [];
    const projectThreads = projectsListed
      ? sortChatThreads(
          unread.filter((thread) => {
            return thread.projectId !== null;
          }),
        )
      : [];
    const threadIds = threadIdsOf(threads);
    const projectThreads$ = computed(() => {
      return projectThreads;
    });

    // Unread navigation keeps this snapshot for both ordering and eligibility.
    return createChatThreadListView({
      threads$: computed(() => {
        return threads;
      }),
      allThreadIds$: computed(() => {
        return threadIds;
      }),
      projectThreads$,
      allProjectThreads$: projectThreads$,
      hideEmptyProjects: true,
      hasHiddenArchivedThreads$: noHiddenArchivedThreads$,
    });
  },
);

export const currentChatThreadList$ = computed(
  async (get): Promise<ChatThreadListSignals> => {
    if (get(chatThreadOnlyUnread$)) {
      return await get(unreadChatThreadListSignals$);
    }
    return await get(currentChatThreadListSignals$);
  },
);

export const chatThreads$ = computed(
  async (get): Promise<EventDrivenChatThread[]> => {
    const list = await get(currentChatThreadList$);
    return get(list.threads$);
  },
);

export const currentChatThreadListIds$ = computed(
  async (get): Promise<readonly string[]> => {
    return threadIdsOf(await get(chatThreads$));
  },
);

// A filtered current chat still needs its position in the complete ordering so
// adjacent navigation can skip hidden chats.
export const currentChatThreadNavigationList$ = computed(
  async (get): Promise<ChatThreadNavigationList> => {
    const list = await get(currentChatThreadList$);
    return get(list.navigation$);
  },
);
