import {
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";

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

test("Restore the mobile chat-list scroll position after reopening the sidebar", async () => {
  context.mocks.browser.matchMedia(false);
  mockThreads(120);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  });
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  click(screen.getByLabelText("Open menu"));
  const drawer = screen.getByRole("dialog", { name: "Sidebar" });
  await within(drawer).findByText("History 1");
  const viewport = within(drawer).getByTestId("sidebar-scroll-area");
  fireEvent.scroll(viewport, { target: { scrollTop: 50 * ROW_HEIGHT } });
  await within(drawer).findByText("History 51");

  click(within(drawer).getByLabelText("Collapse sidebar"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
  });
  click(screen.getByLabelText("Open menu"));
  const reopened = screen.getByRole("dialog", { name: "Sidebar" });
  await within(reopened).findByText("History 51");
  expect(within(reopened).getByTestId("sidebar-scroll-area").scrollTop).toBe(
    50 * ROW_HEIGHT,
  );
  expect(within(reopened).queryByText("History 1")).not.toBeInTheDocument();
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

test.each([true, false])(
  "Follow full-list positions across scrolling and pinning (wave: %s)",
  async (waveEnabled) => {
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
            return [
              threadId(index),
              index === 1 ? "unread" : "active",
            ] as const;
          }),
        ),
        unreadAt: { [threadId(1)]: "2026-03-10T00:05:00Z" },
      });
    });
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ChatRunningIndicatorWave]: waveEnabled,
      },
    });
    const sidebar = screen.getByTestId("chat-list-column");
    const rows = () => {
      return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
    };
    await waitFor(() => {
      expect(rows()).toHaveLength(13);
      expect(runningIndicatorPhase(rows()[2])).toBeCloseTo(
        waveEnabled ? -10 / 12 : 0,
        10,
      );
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
        expect(runningIndicatorPhase(row)).toBeCloseTo(
          waveEnabled ? expectedPhase : 0,
          10,
        );
      }
    });

    scrollArea.scrollTop = 0;
    fireEvent.scroll(scrollArea);
    await within(sidebar).findByText("History 1");
    await waitFor(() => {
      expect(runningIndicatorPhase(rows()[0])).toBe(0);
      expect(runningIndicatorPhase(rows()[2])).toBeCloseTo(
        waveEnabled ? -10 / 12 : 0,
        10,
      );
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
      expect(runningIndicatorPhase(rows()[1])).toBeCloseTo(
        waveEnabled ? -11 / 12 : 0,
        10,
      );
    });
    expect(within(rows()[0]).getByText("Running")).toBeInTheDocument();
    expect(queryAllByRoleFast("link", rows()[0])[0]).toHaveAttribute(
      "href",
      `/chats/${threadId(2)}`,
    );
  },
);

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
