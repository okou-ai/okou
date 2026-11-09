import { command, computed, state } from "ccstate";
import { userNotificationsContract } from "@okouai/api-contracts/client/user-notifications";
import type { UserNotificationSummary } from "@okouai/api-contracts/contracts/user-notifications";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { pageVersion$ } from "../page-signal.ts";
import { onRef } from "../utils.ts";
import { createCarouselSelection } from "../carousel.ts";

function createInboxState() {
  const revision$ = state(0);
  const detailRevision$ = state(0);
  const summaryRevision$ = state(0);
  const open$ = state(false);
  const selectedId$ = state<string | null>(null);
  const lastSelectedId$ = state<string | null>(null);
  const olderPages$ = state<readonly UserNotificationSummary[]>([]);
  const nextOlderCursor$ = state<
    { createdAt: string; id: string } | null | undefined
  >(undefined);
  const readReceipts$ = state<ReadonlyMap<string, string>>(new Map());
  const readThrough$ = state<string | null>(null);
  const readRequest$ = state<Promise<void> | undefined>(undefined);
  const scrollTop$ = state(0);

  const descriptionId = crypto.randomUUID();
  const pageSelection$ = computed((get) => {
    get(detailRevision$);
    return createCarouselSelection();
  });
  return {
    pageSelection$,
    revision$,
    detailRevision$,
    summaryRevision$,
    open$,
    selectedId$,
    lastSelectedId$,
    olderPages$,
    nextOlderCursor$,
    readReceipts$,
    readThrough$,
    readRequest$,
    scrollTop$,
    descriptionId,
  };
}
type InboxState = ReturnType<typeof createInboxState>;

function createInboxQueries(inbox: InboxState) {
  const {
    revision$,
    summaryRevision$,
    detailRevision$,
    selectedId$,
    olderPages$,
    nextOlderCursor$,
    readReceipts$,
    readThrough$,
  } = inbox;
  const summary$ = computed(async (get) => {
    get(summaryRevision$);
    const response = await accept(
      get(apiClient$)(userNotificationsContract).summary(),
      [200],
      undefined,
      { showErrorToast: false },
    );
    return response.body;
  });
  const firstPage$ = computed(async (get) => {
    get(revision$);
    const response = await accept(
      get(apiClient$)(userNotificationsContract).list(),
      [200],
      undefined,
      { showErrorToast: false },
    );
    return response.body;
  });
  const items$ = computed(async (get) => {
    const first = await get(firstPage$);
    const receipts = get(readReceipts$);
    const through = get(readThrough$);
    const items = [...first.items, ...get(olderPages$)];
    return items.map((item) => {
      return {
        ...item,
        readAt:
          item.readAt ??
          receipts.get(item.id) ??
          (through && item.createdAt <= through ? through : null),
      };
    });
  });
  const nextCursor$ = computed(async (get) => {
    const cursor = get(nextOlderCursor$);
    return cursor === undefined ? (await get(firstPage$)).nextCursor : cursor;
  });
  const detail$ = computed(async (get) => {
    get(detailRevision$);
    const id = get(selectedId$);
    if (!id) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(userNotificationsContract).get({ params: { id } }),
      [200],
      undefined,
      { showErrorToast: false },
    );
    return response.body;
  });
  return {
    summary$,
    items$,
    nextCursor$,
    detail$,
  };
}
type InboxQueries = ReturnType<typeof createInboxQueries>;

function createInboxNavigation(inbox: InboxState, queries: InboxQueries) {
  const {
    revision$,
    detailRevision$,
    summaryRevision$,
    open$,
    selectedId$,
    lastSelectedId$,
    olderPages$,
    nextOlderCursor$,
    readRequest$,
    scrollTop$,
  } = inbox;
  const { nextCursor$ } = queries;
  const retryDetail$ = command(({ set }) => {
    set(detailRevision$, (n) => {
      return n + 1;
    });
  });
  const refresh$ = command(({ set }) => {
    set(summaryRevision$, (n) => {
      return n + 1;
    });
    set(revision$, (n) => {
      return n + 1;
    });
    set(olderPages$, []);
    set(nextOlderCursor$, undefined);
  });
  const refreshSummary$ = command(({ set }) => {
    set(summaryRevision$, (n) => {
      return n + 1;
    });
  });
  const setOpen$ = command(({ get, set }, value: boolean) => {
    // A detail dialog temporarily hides the dropdown. Its dismissal returns
    // to the same list rather than treating that handoff as closing the inbox.
    if (get(selectedId$)) {
      return;
    }
    set(open$, value);
    if (value) {
      set(scrollTop$, 0);
      set(refresh$);
    }
  });
  const select$ = command(({ set }, id: string) => {
    set(readRequest$, undefined);
    set(detailRevision$, (n) => {
      return n + 1;
    });
    set(lastSelectedId$, id);
    set(selectedId$, id);
  });
  const closeDetail$ = command(({ set }) => {
    set(selectedId$, null);
  });
  const loadMore$ = command(async ({ get, set }, signal: AbortSignal) => {
    const revision = get(revision$);
    const cursor = await get(nextCursor$);
    signal.throwIfAborted();
    if (!cursor) {
      return;
    }
    const response = await accept(
      get(apiClient$)(userNotificationsContract).list({
        query: { beforeAt: cursor.createdAt, beforeId: cursor.id },
        fetchOptions: { signal },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    const committedCursor = get(nextOlderCursor$);
    if (
      revision !== get(revision$) ||
      (committedCursor !== undefined &&
        (committedCursor === null ||
          committedCursor.id !== cursor.id ||
          committedCursor.createdAt !== cursor.createdAt))
    ) {
      return;
    }
    set(olderPages$, (items) => {
      return [...items, ...response.body.items];
    });
    set(nextOlderCursor$, response.body.nextCursor);
  });
  const listRef$ = onRef(
    command(({ get, set }, element: HTMLDivElement, signal: AbortSignal) => {
      element.scrollTop = get(scrollTop$);
      const lastSelectedId = get(lastSelectedId$);
      if (lastSelectedId) {
        const target =
          element.querySelector<HTMLElement>(
            `[data-notification-id="${lastSelectedId}"]`,
          ) ?? element.querySelector<HTMLElement>("button");
        target?.focus({ preventScroll: true });
      }
      element.addEventListener(
        "scroll",
        () => {
          set(scrollTop$, element.scrollTop);
        },
        { signal },
      );
    }),
  );
  return {
    retryDetail$,
    refresh$,
    refreshSummary$,
    setOpen$,
    select$,
    closeDetail$,
    loadMore$,
    listRef$,
  };
}
type InboxNavigation = ReturnType<typeof createInboxNavigation>;

function createInboxReceipts(
  inbox: InboxState,
  queries: InboxQueries,
  navigation: InboxNavigation,
) {
  const { readReceipts$, readThrough$, readRequest$ } = inbox;
  const { detail$ } = queries;
  const { refreshSummary$ } = navigation;
  const persistRead$ = command(async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(detail$);
    signal.throwIfAborted();
    if (
      !detail ||
      detail.readAt ||
      get(readReceipts$).has(detail.id) ||
      (get(readThrough$) ?? "") >= detail.createdAt
    ) {
      return;
    }
    const response = await accept(
      get(apiClient$)(userNotificationsContract).markRead({
        params: { id: detail.id },
        fetchOptions: { signal },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    set(readReceipts$, (receipts) => {
      return new Map(receipts).set(detail.id, response.body.readAt);
    });
    set(refreshSummary$);
  });
  const markRead$ = command(({ set }, signal: AbortSignal) => {
    const request = set(persistRead$, signal);
    set(readRequest$, request);
    return request;
  });
  const detailRef$ = onRef(
    command(async ({ set }, _element: HTMLElement, signal: AbortSignal) => {
      // Only mounted, successfully decoded detail content earns a read receipt.
      await set(markRead$, signal);
    }),
  );
  const markAllRead$ = command(async ({ get, set }, signal: AbortSignal) => {
    const response = await accept(
      get(apiClient$)(userNotificationsContract).markAllRead({
        fetchOptions: { signal },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    set(readThrough$, response.body.readThrough);
    set(refreshSummary$);
  });
  return {
    markRead$,
    markAllRead$,
    detailRef$,
  };
}

function createNotificationInbox() {
  const inbox = createInboxState();
  const queries = createInboxQueries(inbox);
  const navigation = createInboxNavigation(inbox, queries);
  const receipts = createInboxReceipts(inbox, queries, navigation);
  return {
    ...queries,
    ...navigation,
    ...receipts,
    open$: inbox.open$,
    selectedId$: inbox.selectedId$,
    lastSelectedId$: inbox.lastSelectedId$,
    readRequest$: inbox.readRequest$,
    descriptionId: inbox.descriptionId,
    pageSelection$: inbox.pageSelection$,
  };
}

// A replaced session/page creates fresh UI state and receipts: no other user's
// content or in-flight result can be reused by the new owner.
export const notificationInbox$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(pageVersion$);
  return createNotificationInbox();
});
export type NotificationInbox = ReturnType<typeof createNotificationInbox>;

export const watchUserNotifications$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const inbox = get(notificationInbox$);
    const refresh = () => {
      if (!document.hidden) {
        set(inbox.refreshSummary$);
      }
    };
    window.addEventListener("focus", refresh, { signal });
    document.addEventListener("visibilitychange", refresh, { signal });
  },
);
