import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { chatThreadIndicatorsFromWorker$ } from "./shared-database.ts";
import { chatThreadOnlyUnread$ } from "./chat-page/chat-thread-only-unread.ts";
import { chatThreadOnlyArchived$ } from "./chat-page/chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "./chat-page/chat-thread-only-muted.ts";
import { eventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { projects$ } from "./projects/projects.ts";
import { expandedProjectIds$ } from "./projects/project-expansion.ts";
import { computed, type Computed } from "ccstate";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";

import {
  buildChatThreadListRows,
  buildChatThreadNavigationList,
  threadRowKey,
  type ChatThreadListRow,
  type ChatThreadNavigationList,
} from "./chat-page/chat-thread-list-rows.ts";

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

export interface ChatThreadListSignals {
  /** Listed chats outside Projects, which own number shortcuts. */
  readonly threads$: Computed<Promise<EventDrivenChatThread[]>>;
  /** Listed chats inside Projects, including the ones a fold hides. */
  readonly projectThreads$: Computed<Promise<readonly EventDrivenChatThread[]>>;
  readonly threadIds$: Computed<Promise<readonly string[]>>;
  readonly rows$: Computed<Promise<readonly ChatThreadListRow[]>>;
  readonly navigation$: Computed<Promise<ChatThreadNavigationList>>;
  readonly count$: Computed<Promise<number>>;
  readonly currentThreadListed$: Computed<Promise<boolean>>;
  readonly hasHiddenArchivedThreads$: Computed<Promise<boolean>>;
}

interface ChatThreadListFilter {
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

const allProjectThreads$ = computed((get): Promise<EventDrivenChatThread[]> => {
  return Promise.resolve(
    sortChatThreads(
      get(eventDrivenChatThreads$).filter((thread) => {
        return thread.projectId !== null;
      }),
    ),
  );
});

function createChatThreadListView({
  threads$,
  allThreadIds$,
  projectThreads$,
  allProjectThreads$: allProjectThreadsSource$,
  projectIdsWithHiddenArchivedThreads$,
  hideEmptyProjects,
  hasHiddenArchivedThreads$,
}: {
  threads$: Computed<Promise<EventDrivenChatThread[]>>;
  allThreadIds$: Computed<Promise<readonly string[]>>;
  projectThreads$: Computed<Promise<readonly EventDrivenChatThread[]>>;
  allProjectThreads$: Computed<Promise<readonly EventDrivenChatThread[]>>;
  projectIdsWithHiddenArchivedThreads$: Computed<Promise<ReadonlySet<string>>>;
  hideEmptyProjects: boolean;
  hasHiddenArchivedThreads$: Computed<Promise<boolean>>;
}): ChatThreadListSignals {
  const threadIds$ = computed(async (get): Promise<readonly string[]> => {
    return threadIdsOf(await get(threads$));
  });
  const rows$ = computed(async (get): Promise<readonly ChatThreadListRow[]> => {
    const expandedProjectIds = get(expandedProjectIds$);
    const [
      projects,
      projectThreads,
      projectIdsWithHiddenArchivedThreads,
      threadIds,
    ] = await Promise.all([
      get(projects$),
      get(projectThreads$),
      get(projectIdsWithHiddenArchivedThreads$),
      get(threadIds$),
    ]);
    return buildChatThreadListRows({
      projects,
      expandedProjectIds,
      projectThreads,
      projectIdsWithHiddenArchivedThreads,
      threadIds,
      hideEmptyProjects,
    });
  });
  const navigation$ = computed(
    async (get): Promise<ChatThreadNavigationList> => {
      const [projects, rows, allProjectThreads, allThreadIds] =
        await Promise.all([
          get(projects$),
          get(rows$),
          get(allProjectThreadsSource$),
          get(allThreadIds$),
        ]);
      return buildChatThreadNavigationList({
        projects,
        rows,
        allProjectThreads,
        allThreadIds,
      });
    },
  );

  return {
    threads$,
    projectThreads$,
    threadIds$,
    rows$,
    navigation$,
    count$: computed(async (get): Promise<number> => {
      return (await get(rows$)).length;
    }),
    currentThreadListed$: computed(async (get): Promise<boolean> => {
      const threadId = get(currentChatThreadId$);
      return threadId
        ? (await get(navigation$)).listedKeys.includes(threadRowKey(threadId))
        : false;
    }),
    hasHiddenArchivedThreads$,
  };
}

function createChatThreadListSignals(
  filter: ChatThreadListFilter,
): ChatThreadListSignals {
  const allThreads$ = computed((get): Promise<EventDrivenChatThread[]> => {
    return Promise.resolve(
      sortChatThreads(
        get(eventDrivenChatThreads$).filter((thread) => {
          return thread.projectId === null;
        }),
      ),
    );
  });
  const listed = (thread: EventDrivenChatThread) => {
    if (filter.onlyMuted) {
      return thread.muted;
    }
    return filter.onlyArchived ? thread.archived : !thread.archived;
  };
  // Only the inbox leaves archived chats out and explains an empty list.
  const inbox = !filter.onlyArchived && !filter.onlyMuted;
  const threads$ = computed(async (get): Promise<EventDrivenChatThread[]> => {
    return (await get(allThreads$)).filter(listed);
  });

  return createChatThreadListView({
    threads$,
    allThreadIds$: computed(async (get): Promise<readonly string[]> => {
      return threadIdsOf(await get(allThreads$));
    }),
    // A filter applies to the chats inside Projects as it does to the rest.
    projectThreads$: computed(
      async (get): Promise<readonly EventDrivenChatThread[]> => {
        return (await get(allProjectThreads$)).filter(listed);
      },
    ),
    allProjectThreads$,
    projectIdsWithHiddenArchivedThreads$: computed(
      async (get): Promise<ReadonlySet<string>> => {
        const projectIds = new Set<string>();
        if (inbox) {
          for (const thread of await get(allProjectThreads$)) {
            if (thread.archived && thread.projectId !== null) {
              projectIds.add(thread.projectId);
            }
          }
        }
        return projectIds;
      },
    ),
    hideEmptyProjects: !inbox,
    hasHiddenArchivedThreads$: computed(async (get): Promise<boolean> => {
      return (
        inbox &&
        (await get(allThreads$)).some((thread) => {
          return thread.archived;
        })
      );
    }),
  });
}

// Thread events update the current list projection.
const currentChatThreadListSignals$ = computed((get): ChatThreadListSignals => {
  const onlyArchived = get(chatThreadOnlyArchived$);

  return createChatThreadListSignals({
    onlyArchived,
    onlyMuted: get(chatThreadOnlyMuted$),
  });
});

// The unread list hides Projects without unread chats and offers every chat
// instead of explaining what it leaves out.
const notInbox$ = computed(() => {
  return Promise.resolve(false);
});
const noProjectIds$ = computed((): Promise<ReadonlySet<string>> => {
  return Promise.resolve(new Set());
});

// Indicators only affect the unread list.
// The Unread filter always includes archived threads, so an archived thread
// never hides an unread message.
export const unreadChatThreadListSignals$ = computed(
  async (get): Promise<ChatThreadListSignals> => {
    const indicators = await get(chatThreadIndicatorsFromWorker$);

    const unread = get(eventDrivenChatThreads$).filter((thread) => {
      return indicators.threads[thread.id] === "unread";
    });
    const threads = sortChatThreads(
      unread.filter((thread) => {
        return thread.projectId === null;
      }),
    );
    const projectThreads = sortChatThreads(
      unread.filter((thread) => {
        return thread.projectId !== null;
      }),
    );
    const threadIds = threadIdsOf(threads);
    const projectThreads$ = computed(() => {
      return Promise.resolve(projectThreads);
    });

    // Unread navigation keeps this snapshot for both ordering and eligibility.
    return createChatThreadListView({
      threads$: computed(() => {
        return Promise.resolve(threads);
      }),
      allThreadIds$: computed(() => {
        return Promise.resolve(threadIds);
      }),
      projectThreads$,
      allProjectThreads$: projectThreads$,
      projectIdsWithHiddenArchivedThreads$: noProjectIds$,
      hideEmptyProjects: true,
      hasHiddenArchivedThreads$: notInbox$,
    });
  },
);

export const currentChatThreadList$ = computed(
  async (get): Promise<ChatThreadListSignals> => {
    if (get(chatThreadOnlyUnread$)) {
      return await get(unreadChatThreadListSignals$);
    }
    return get(currentChatThreadListSignals$);
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
