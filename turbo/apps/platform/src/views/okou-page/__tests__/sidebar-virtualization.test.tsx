import {
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const ROW_HEIGHT = 36;

function threadId(index: number): string {
  return `b3200000-0000-4000-a000-${String(index).padStart(12, "0")}`;
}

function mockThreads(count: number): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: Array.from({ length: count }, (_, index) => {
          return {
            id: threadId(index),
            agentId: AGENT_ID,
            title: `History ${index + 1}`,
            sortAt: new Date(
              Date.parse("2026-03-10T00:00:00Z") + (count - index) * 1000,
            ).toISOString(),
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            pinnedAt: null,
            archived: false,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          };
        }),
        latestEventId: null,
        latestSeqId: null,
      }),
    );
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {}, unreadAt: {} });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [] });
  });
}

function mockViewportHeight(height: () => number, threadCount = 120): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "sidebar-scroll-area" ? height() : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "sidebar-scroll-area"
        ? threadCount * ROW_HEIGHT
        : 0;
    },
  );
}

const PWA_ROW_HEIGHT = 60;

function mockPwaViewportHeight(
  height: () => number,
  threadCount: number,
): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.slot === "scroll-area-viewport" ? height() : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.slot === "scroll-area-viewport"
        ? threadCount * PWA_ROW_HEIGHT
        : 0;
    },
  );
}

function resizeWindow(): void {
  fireEvent(window, new Event("resize"));
}

function selectChatListFilter(sidebar: HTMLElement, filter: "Unread"): void {
  click(within(sidebar).getByLabelText("Open chat list menu"));
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim().startsWith(filter);
  });
  if (!item) {
    throw new Error(`${filter} menu item is missing`);
  }
  click(item);
}

test("Keep the chat viewport keyboard-focusable only while a conversation is open", async () => {
  const threadCount = 32;
  mockThreads(threadCount);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  }, threadCount);
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const sidebar = await screen.findByTestId("chat-list-column");
  const viewport = await within(sidebar).findByTestId("sidebar-scroll-area");
  const first = await within(viewport).findByText("History 1");
  expect(viewport).toHaveAttribute("tabindex", "-1");

  click(first);
  await waitFor(() => {
    expect(viewport).toHaveAttribute("tabindex", "0");
  });
  viewport.focus();
  expect(viewport).toHaveFocus();

  click(
    within(sidebar).getByLabelText("New chat", {
      selector: "button[aria-keyshortcuts]",
    }),
  );
  await waitFor(() => {
    expect(viewport).toHaveAttribute("tabindex", "-1");
  });
});

test("Keyboard navigation reveals an adjacent conversation outside the virtual window", async () => {
  const threadCount = 32;
  mockThreads(threadCount);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  }, threadCount);
  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = await screen.findByTestId("chat-list-column");
  const viewport = await within(sidebar).findByTestId("sidebar-scroll-area");
  const first = await within(viewport).findByText("History 1");
  await waitFor(() => {
    expect(first.closest("a")).toHaveAttribute("aria-current", "page");
  });
  expect(viewport).toHaveAttribute("tabindex", "0");
  viewport.focus();
  expect(viewport).toHaveFocus();
  // The next conversation lies outside the scrolled window. Keyboard
  // navigation must bring it back into view without losing the viewport.
  fireEvent.scroll(viewport, { target: { scrollTop: 16 * ROW_HEIGHT } });
  await within(viewport).findByText("History 17");
  fireEvent.keyDown(viewport, {
    key: "ArrowDown",
    ctrlKey: true,
    shiftKey: true,
  });
  const next = await within(viewport).findByText("History 2");
  await waitFor(() => {
    expect(next.closest("a")).toHaveAttribute("aria-current", "page");
    expect(viewport.scrollTop).toBe(ROW_HEIGHT);
  });
  expect(viewport).toHaveAttribute("tabindex", "0");
});

test("Resize and navigate a loaded virtual viewport", async () => {
  const threadCount = 6406;
  mockThreads(threadCount);
  let viewportHeight = 612;
  mockViewportHeight(() => {
    return viewportHeight;
  }, threadCount);

  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = await screen.findByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(25);
  });
  expect(within(sidebar).getByText("History 25")).toBeInTheDocument();
  expect(within(sidebar).queryByText("History 26")).not.toBeInTheDocument();

  viewportHeight = 900;
  resizeWindow();
  await waitFor(() => {
    expect(rows()).toHaveLength(33);
  });
  viewportHeight = 360;
  resizeWindow();
  await waitFor(() => {
    expect(rows()).toHaveLength(18);
  });

  const nextThread = queryAllByRoleFast("link", sidebar).find((link) => {
    return link.getAttribute("href") === `/chats/${threadId(1)}`;
  });
  if (!nextThread) {
    throw new Error("Second sidebar thread is not mounted");
  }
  click(nextThread);
  await waitFor(() => {
    expect(nextThread).toHaveAttribute("aria-current", "page");
  });
  expect(rows()).toHaveLength(18);
});

async function setupUnreadHistoryBeyondCurrentWindow() {
  mockThreads(120);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  });
  const indicators = context.mocks.deferred<void>();
  const unreadIndexes = Array.from({ length: 30 }, (_, index) => {
    return index + 40;
  });
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    await indicators.promise;
    return respond(200, {
      agents: { [AGENT_ID]: "unread" },
      threads: {
        ...Object.fromEntries(
          unreadIndexes.map((index) => {
            return [threadId(index), "unread" as const];
          }),
        ),
        [threadId(100)]: "active",
      },
      unreadAt: {},
    });
  });
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const sidebar = screen.getByTestId("chat-list-column");
  await within(sidebar).findByText("History 1");
  expect(within(sidebar).queryByText("History 41")).not.toBeInTheDocument();
  selectChatListFilter(sidebar, "Unread");
  await within(sidebar).findAllByTestId("sidebar-skeleton");
  expect(within(sidebar).queryByText("History 1")).not.toBeInTheDocument();
  expect(
    within(sidebar).queryByText("No unread chats"),
  ).not.toBeInTheDocument();
  indicators.resolve();
  await within(sidebar).findByText("History 70");
  return { sidebar, unreadIndexes };
}

test("Show every unread conversation beyond the current history window", async () => {
  const { sidebar, unreadIndexes } =
    await setupUnreadHistoryBeyondCurrentWindow();
  for (const index of unreadIndexes) {
    expect(
      within(sidebar).getByText(`History ${index + 1}`),
    ).toBeInTheDocument();
  }
  expect(within(sidebar).queryByText("History 1")).not.toBeInTheDocument();
  expect(within(sidebar).queryByText("History 101")).not.toBeInTheDocument();
});

function runningIndicatorPhase(row: HTMLElement): number {
  const indicator = within(row).getByTestId(
    "chat-thread-state-indicator",
  ).firstElementChild;
  if (!(indicator instanceof HTMLElement)) {
    throw new Error("Running indicator is missing");
  }
  const phase = indicator.style.getPropertyValue("--running-indicator-phase");
  expect(phase).not.toBe("");
  return Number(phase);
}

test("Follow full-list wave positions across scrolling and pinning", async () => {
  mockThreads(120);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  });
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [AGENT_ID]: "active" },
      threads: Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => {
          return [threadId(index), index === 1 ? "unread" : "active"] as const;
        }),
      ),
      unreadAt: { [threadId(1)]: "2026-03-10T00:05:00Z" },
    });
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  const sidebar = screen.getByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(13);
    expect(runningIndicatorPhase(rows()[2])).toBeCloseTo(-10 / 12, 10);
  });
  await within(rows()[1]).findByText("Unread");
  expect(within(rows()[2]).getByText("Running")).toBeInTheDocument();

  const scrollArea = within(sidebar).getByTestId("sidebar-scroll-area");
  scrollArea.scrollTop = 40 * ROW_HEIGHT;
  fireEvent.scroll(scrollArea);
  await within(sidebar).findByText("History 41");
  expect(within(sidebar).queryByText("History 1")).not.toBeInTheDocument();
  expect(Number(rows()[0].dataset.index)).toBeGreaterThan(0);
  await waitFor(() => {
    for (const row of rows()) {
      const index = Number(row.dataset.index);
      const expectedPhase = index % 12 === 0 ? 0 : (index % 12) / 12 - 1;
      expect(runningIndicatorPhase(row)).toBeCloseTo(expectedPhase, 10);
    }
  });

  scrollArea.scrollTop = 0;
  fireEvent.scroll(scrollArea);
  await within(sidebar).findByText("History 1");
  await waitFor(() => {
    expect(runningIndicatorPhase(rows()[0])).toBe(0);
    expect(runningIndicatorPhase(rows()[2])).toBeCloseTo(-10 / 12, 10);
  });

  click(within(rows()[2]).getByLabelText("Open chat menu"));
  await screen.findByRole("menu");
  const pin = queryAllByRoleFast("menuitem").find((item) => {
    return item.getAttribute("aria-label") === "Pin chat";
  });
  if (!pin) {
    throw new Error("Pin menu item is missing");
  }
  click(pin);
  await waitFor(() => {
    expect(within(rows()[0]).getByText("History 3")).toBeInTheDocument();
    expect(runningIndicatorPhase(rows()[0])).toBe(0);
    expect(runningIndicatorPhase(rows()[1])).toBeCloseTo(-11 / 12, 10);
  });
  expect(within(rows()[0]).getByText("Running")).toBeInTheDocument();
  expect(queryAllByRoleFast("link", rows()[0])[0]).toHaveAttribute(
    "href",
    `/chats/${threadId(2)}`,
  );
});

function mockPinnedGrid(): string {
  const agents = Array.from({ length: 5 }, (_, index) => {
    return {
      agentId: `c0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      ownerId: "test-user-123",
      displayName: index === 0 ? "Nova" : `Agent ${index + 1}`,
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public" as const,
    };
  });
  context.mocks.data.agents(agents);
  context.mocks.data.userPreferences({
    pinnedAgentIds: agents.slice(1, 4).map((agent) => {
      return agent.agentId;
    }),
  });
  return "c0000000-0000-4000-a000-000000000005";
}

function pinToggle(container: HTMLElement, name: "Pin" | "Unpin"): HTMLElement {
  return within(container).getByRole("option", { name: `Agent 5 ${name}` });
}

test("Refresh virtualization after pinning adds a grid row and unpinning removes it", async () => {
  mockThreads(120);
  mockPinnedGrid();
  mockViewportHeight(() => {
    const cards = document.querySelectorAll(
      '[data-testid="pinned-agent-card"]',
    );
    return cards.length > 4 ? 360 : 612;
  });
  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = screen.getByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    return expect(rows()).toHaveLength(25);
  });

  click(screen.getByLabelText("Pin an agent"));
  const dialog = await screen.findByTestId("pin-agent-dialog-list");
  click(pinToggle(dialog, "Pin"));
  await waitFor(() => {
    expect(within(sidebar).getAllByTestId("pinned-agent-card")).toHaveLength(5);
    expect(rows()).toHaveLength(18);
  });
  await waitFor(() => {
    return expect(pinToggle(dialog, "Unpin")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(pinToggle(dialog, "Unpin"));
  await waitFor(() => {
    expect(within(sidebar).getAllByTestId("pinned-agent-card")).toHaveLength(4);
    expect(rows()).toHaveLength(25);
  });
});

test("Measure the mobile chat list only after the main stylesheet bounds it", async () => {
  const pwaRowHeight = 60;
  const threadCount = 120;
  const stylesheet = createDeferredPromise<"loaded">(context.signal);
  const originalStylesheetLoaded = window.__mainStylesheetLoaded;
  window.__mainStylesheetLoaded = stylesheet.promise;
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalStylesheetLoaded) {
        window.__mainStylesheetLoaded = originalStylesheetLoaded;
      } else {
        delete window.__mainStylesheetLoaded;
      }
    },
    { once: true },
  );
  context.mocks.browser.matchMedia((query) => {
    return query === "(display-mode: standalone)";
  });
  mockThreads(threadCount);
  let stylesheetActive = false;
  // Without the stylesheet the viewport grows to the whole list.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.slot !== "scroll-area-viewport") {
        return 0;
      }
      return stylesheetActive ? 5 * pwaRowHeight : threadCount * pwaRowHeight;
    },
  );

  const page = await startPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await screen.findByRole("navigation", { name: "Main navigation" });
  // Workspace search lists the same chats outside the chat list, so finding
  // one proves the rows are ready; only the stylesheet holds the list back.
  click(await screen.findByLabelText("Search workspace"));
  const search = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await within(search).findAllByText("History 1");
  expect(
    screen.queryAllByTestId("sidebar-chat-thread-virtual-row"),
  ).toHaveLength(0);
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => {
    expect(search).not.toBeInTheDocument();
  });

  stylesheetActive = true;
  stylesheet.resolve("loaded");
  await page.ready;
  await screen.findByText("History 1");
  await waitFor(() => {
    expect(
      screen.getAllByTestId("sidebar-chat-thread-virtual-row"),
    ).toHaveLength(13);
  });
});

test("Restore the mobile chat-list scroll position after returning from a conversation", async () => {
  const threadCount = 32;
  context.mocks.browser.matchMedia(false);
  mockThreads(threadCount);
  mockPwaViewportHeight(() => {
    return 5 * PWA_ROW_HEIGHT;
  }, threadCount);
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const list = await screen.findByRole("region", { name: "Chat threads" });
  await within(list).findByText("History 1");
  fireEvent.scroll(list, { target: { scrollTop: 16 * PWA_ROW_HEIGHT } });
  click(await within(list).findByText("History 17"));
  await screen.findByRole("textbox", { name: "Message" });

  click(screen.getByLabelText("Back to chats"));
  const restored = await screen.findByRole("region", { name: "Chat threads" });
  await within(restored).findByText("History 17");
  expect(restored.scrollTop).toBe(16 * PWA_ROW_HEIGHT);
});

test("Remeasure the mobile chat list when a service notice arrives and is dismissed", async () => {
  const threadCount = 120;
  context.mocks.browser.matchMedia(false);
  mockThreads(threadCount);
  const incident = createDeferredPromise<void>(context.signal);
  context.mocks.http.get("https://api.instatus.com/issues", async () => {
    await incident.promise;
    return HttpResponse.json({
      activeIncidents: [
        {
          id: "incident-api-latency",
          name: "API requests are delayed",
          status: "INVESTIGATING",
        },
      ],
    });
  });
  mockPwaViewportHeight(() => {
    const notice = document.querySelector(
      '[role="region"][aria-label="Service status updates"]',
    );
    return notice ? 5 * PWA_ROW_HEIGHT : 12 * PWA_ROW_HEIGHT;
  }, threadCount);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
  });
  const list = await screen.findByRole("region", { name: "Chat threads" });
  const rows = () => {
    return within(list).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(20);
  });

  incident.resolve();
  await screen.findByRole("region", { name: "Service status updates" });
  await waitFor(() => {
    expect(rows()).toHaveLength(13);
  });

  click(screen.getByLabelText("Dismiss service update"));
  await waitFor(() => {
    expect(rows()).toHaveLength(20);
  });
});
