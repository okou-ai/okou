import { screen, within } from "@testing-library/react";

import {
  chatThreadByIdContract,
  chatThreadArchiveContract,
  chatThreadMuteContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import type { ChatThreadEventQueryResult } from "../../../signals/chat-database/types.ts";
import {
  mockChatThreadSnapshotResponse,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";

export interface SidebarThread {
  readonly id: string;
  readonly title: string | null;

  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null;
  readonly archived?: boolean;
  readonly muted?: boolean;
  readonly renamedAt?: string | null;
  /** Overrides the ordering-derived `sortAt` when a test asserts on its age. */
  readonly sortAt?: string;
}

function sidebarThreadSnapshot(
  threads: readonly SidebarThread[],
): NonNullable<ChatThreadEventQueryResult["snapshot"]> {
  return {
    chatThreads: threads.map((thread, index) => {
      return {
        id: thread.id,

        title: thread.title,
        sortAt:
          thread.sortAt ??
          new Date(
            Date.parse("2026-03-10T00:00:00Z") +
              (threads.length - index) * 1000,
          ).toISOString(),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        pinnedAt: thread.pinnedAt ?? null,
        archived: thread.archived ?? false,
        muted: thread.muted ?? false,
        renamedAt: thread.renamedAt ?? null,
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
      };
    }),
    latestEventId: null,
    latestSeqId: null,
  };
}

export function mockChatThreadSnapshot(
  targetContext: TestContext,
  threads: () => readonly SidebarThread[],
  activeThreadIds: () => readonly string[] = () => {
    return [];
  },
  remoteGate?: Promise<void>,
): void {
  targetContext.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    await remoteGate;
    return respond(
      200,
      mockChatThreadSnapshotResponse(
        targetContext,
        sidebarThreadSnapshot(threads()),
      ),
    );
  });
  targetContext.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  targetContext.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: Object.fromEntries(
        activeThreadIds().map((threadId) => {
          return [threadId, "active" as const];
        }),
      ),
      unreadAt: {},
    });
  });
  targetContext.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  targetContext.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [] });
  });
}

export function menuItemByText(text: string): HTMLElement {
  const item = queryMenuItemByText(text);
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

export function queryMenuItemByText(text: string): HTMLElement | null {
  return (
    [
      ...queryAllByRoleFast("menuitem"),
      ...queryAllByRoleFast("menuitemradio"),
    ].find((candidate) => {
      const semanticContent = candidate.cloneNode(true);
      if (!(semanticContent instanceof HTMLElement)) {
        return false;
      }
      for (const hidden of semanticContent.querySelectorAll(
        '[aria-hidden="true"]',
      )) {
        hidden.remove();
      }
      return (
        candidate.getAttribute("aria-label") === text ||
        semanticContent.textContent?.replace(/\s+/g, " ").trim() === text
      );
    }) ?? null
  );
}

export function sidebar(): HTMLElement {
  return screen.getByTestId("chat-list-column");
}

export function threadRowByTitle(
  title: string,
  container: HTMLElement = sidebar(),
): HTMLElement {
  const link = threadLinkByTitle(title, container);
  const row = link.parentElement;
  if (!row) {
    throw new Error(`${title} thread row not found`);
  }
  return row;
}

export function threadLinkByTitle(
  title: string,
  container: HTMLElement = sidebar(),
): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return (
      candidate
        .querySelector('[data-slot="sidebar-thread-title"]')
        ?.textContent?.replace(/\s+/g, " ")
        .trim() === title
    );
  });
  if (!link) {
    throw new Error(`${title} thread link not found`);
  }
  return link;
}

export function openThreadMenu(title: string): void {
  click(
    within(threadRowByTitle(title)).getByTestId("chat-thread-menu-trigger"),
  );
}

export function openChatListMenu(): void {
  click(within(sidebar()).getByLabelText("Open chat list menu"));
}

export function mockSidebarThreadStory(
  targetContext: TestContext,
  firstPageThreads: SidebarThread[],
  extraThreads: SidebarThread[] = [],
  activeThreadIds: readonly string[] = [],
  remoteGate?: Promise<void>,
): ChatThreadEventQueryResult {
  let threads = [...firstPageThreads];

  mockChatThreadSnapshot(
    targetContext,
    () => {
      return [...threads, ...extraThreads];
    },
    () => {
      return activeThreadIds;
    },
    remoteGate,
  );

  targetContext.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  targetContext.mocks.api(chatThreadPinContract.pin, ({ params, respond }) => {
    threads = threads.map((thread) => {
      return thread.id === params.id
        ? { ...thread, pinnedAt: "2026-03-10T12:00:00Z" }
        : thread;
    });
    return respond(204);
  });
  targetContext.mocks.api(
    chatThreadUnpinContract.unpin,
    ({ params, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id ? { ...thread, pinnedAt: null } : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
    chatThreadMuteContract.mute,
    ({ params, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id ? { ...thread, muted: true } : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
    chatThreadMuteContract.unmute,
    ({ params, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id ? { ...thread, muted: false } : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
    chatThreadArchiveContract.archive,
    ({ params, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id ? { ...thread, archived: true } : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
    chatThreadArchiveContract.unarchive,
    ({ params, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id
          ? { ...thread, archived: false }
          : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
    chatThreadRenameContract.rename,
    ({ params, body, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id
          ? {
              ...thread,
              title: body.title,
              renamedAt: "2026-03-10T12:01:00Z",
            }
          : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
    chatThreadByIdContract.delete,
    ({ params, respond }) => {
      threads = threads.filter((thread) => {
        return thread.id !== params.id;
      });
      return respond(204);
    },
  );

  return {
    snapshot: sidebarThreadSnapshot([...threads, ...extraThreads]),
    events: [],
  };
}
