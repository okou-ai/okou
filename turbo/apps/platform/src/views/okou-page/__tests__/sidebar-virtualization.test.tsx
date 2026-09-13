import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

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
    return respond(200, {
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
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
          selectedVideoModel: null,
        };
      }),
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {} });
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

test("entering the scrolled list keeps the visible threads available for navigation", async () => {
  // Thirty rows exceed this five-row viewport plus its overscan. Row 21
  // starts outside the top window while keeping the rendered fixture small.
  mockThreads(30);
  mockViewportHeight(() => {
    return 5 * ROW_HEIGHT;
  }, 30);
  await setupPage({ context, path: `/chats/${threadId(20)}` });
  const sidebar = screen.getByTestId("chat-list-column");
  await within(sidebar).findByText("History 21");
  const viewport = within(sidebar).getByTestId("sidebar-scroll-area");
  await waitFor(() => {
    expect(viewport.scrollTop).toBe(20 * ROW_HEIGHT);
  });
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  const title = await within(sidebar).findByText("History 1");
  expect(within(sidebar).queryByText("History 21")).not.toBeInTheDocument();
  const link = title.closest("a");
  const user = userEvent.setup({ delay: null });
  act(() => {
    viewport.focus();
  });
  await user.keyboard("{Tab}");
  expect(link).toHaveFocus();
  expect(viewport.scrollTop).toBe(0);
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${threadId(0)}`);
  });
});

function queueAnimationFrames(): () => void {
  let nextFrameId = 0;
  let callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrameId += 1;
    callbacks.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    callbacks.delete(frameId);
  });

  return () => {
    act(() => {
      const scheduled = Array.from(callbacks.values());
      callbacks = new Map();
      for (const callback of scheduled) {
        callback(performance.now());
      }
    });
  };
}

test("Wait for styles before mounting the virtual viewport", async () => {
  const threadCount = 6406;
  mockThreads(threadCount);
  const stylesheet = context.mocks.deferred<"loaded" | "failed">();
  vi.stubGlobal("__mainStylesheetLoaded", stylesheet.promise);
  let viewportHeight = threadCount * ROW_HEIGHT;
  mockViewportHeight(() => {
    return viewportHeight;
  }, threadCount);

  const page = await startPage({
    context,
    path: `/chats/${threadId(0)}`,
  });
  const sidebar = await screen.findByTestId("chat-list-column");
  await within(sidebar).findByTestId("pinned-agent-card");
  expect(
    within(sidebar).queryByTestId("sidebar-scroll-area"),
  ).not.toBeInTheDocument();
  expect(
    within(sidebar).queryAllByTestId("sidebar-chat-thread-virtual-row"),
  ).toHaveLength(0);

  // CSS is active before its existing readiness promise resolves.
  viewportHeight = 612;
  stylesheet.resolve("loaded");
  await page.ready;
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(25);
  });
  expect(within(sidebar).getByText("History 25")).toBeInTheDocument();
  expect(within(sidebar).queryByText("History 26")).not.toBeInTheDocument();
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

test("Keep the virtual viewport unmounted when the main stylesheet fails", async () => {
  mockThreads(120);
  vi.stubGlobal("__mainStylesheetLoaded", Promise.resolve("failed"));
  await startPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = await screen.findByTestId("chat-list-column");
  await within(sidebar).findByTestId("pinned-agent-card");
  expect(
    within(sidebar).queryByTestId("sidebar-scroll-area"),
  ).not.toBeInTheDocument();
  expect(screen.getByTestId("app-skeleton")).not.toHaveAttribute(
    "aria-hidden",
    "true",
  );
});

test("Use the fallback window before sidebar geometry is available", async () => {
  mockThreads(120);
  await setupPage({ context, path: `/chats/${threadId(0)}` });

  const sidebar = screen.getByTestId("chat-list-column");
  await waitFor(() => {
    expect(
      within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row"),
    ).toHaveLength(100);
  });
  expect(within(sidebar).getByText("History 100")).toBeInTheDocument();
  expect(within(sidebar).queryByText("History 101")).not.toBeInTheDocument();
});

test("Do not retain rows or show an empty state when the list query fails", async () => {
  mockThreads(120);
  const unreads = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.unreads, async ({ respond }) => {
    await unreads.promise;
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Unread conversations are unavailable",
      },
    });
  });
  await setupPage({ context, path: `/chats/${threadId(0)}` });

  const sidebar = screen.getByTestId("chat-list-column");
  await within(sidebar).findByText("History 1");
  click(within(sidebar).getByLabelText("Open chat list menu"));
  const unreadOnlyItem = queryAllByRoleFast("menuitem").find((item) => {
    return item.textContent?.trim() === "Unread only";
  });
  if (!unreadOnlyItem) {
    throw new Error("Unread-only menu item is missing");
  }
  click(unreadOnlyItem);

  await waitFor(() => {
    expect(within(sidebar).queryByText("History 1")).not.toBeInTheDocument();
    expect(within(sidebar).getAllByTestId("sidebar-skeleton")).toHaveLength(3);
  });

  unreads.resolve(undefined);
  await waitFor(() => {
    expect(within(sidebar).queryAllByTestId("sidebar-skeleton")).toHaveLength(
      0,
    );
  });
  const [visibleError] = await screen.findAllByText(
    "Unread conversations are unavailable",
  );
  expect(visibleError).toBeVisible();
  expect(
    within(sidebar).queryByText("No unread chats"),
  ).not.toBeInTheDocument();
  expect(
    within(sidebar).queryByTestId("sidebar-chat-threads-virtual-list"),
  ).not.toBeInTheDocument();
});

test("Coalesce sidebar resize bursts and cancel pending measurements when hidden", async () => {
  mockThreads(120);
  let viewportHeight = 612;
  mockViewportHeight(() => {
    return viewportHeight;
  });
  await setupPage({
    context,
    path: `/chats/${threadId(0)}`,
  });

  const sidebar = screen.getByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(25);
  });

  const viewport = within(sidebar).getByTestId("sidebar-scroll-area");
  let heightReads = 0;
  vi.spyOn(viewport, "clientHeight", "get").mockImplementation(() => {
    heightReads += 1;
    return viewportHeight;
  });
  vi.spyOn(viewport, "scrollHeight", "get").mockReturnValue(120 * ROW_HEIGHT);
  const flushFrame = queueAnimationFrames();

  resizeWindow();
  viewportHeight = 900;
  resizeWindow();
  viewportHeight = 360;
  resizeWindow();

  // Intermediate layouts must not force repeated geometry reads. The single
  // frame measurement must use the latest height and update the visible rows.
  expect(heightReads).toBe(0);
  flushFrame();
  expect(heightReads).toBe(1);
  await waitFor(() => {
    expect(rows()).toHaveLength(18);
  });

  heightReads = 0;
  viewportHeight = 900;
  resizeWindow();
  click(within(sidebar).getByLabelText("Hide chat list"));
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  });
  resizeWindow();
  flushFrame();
  expect(heightReads).toBe(0);
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
  const row = within(container).getByText("Agent 5").closest('[role="option"]');
  if (!(row instanceof HTMLElement)) {
    throw new Error("Fifth agent is missing from the pin manager");
  }
  const button = queryAllByRoleFast("button", row).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`${name} button is missing from the pin manager`);
  }
  return button;
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
    return expect(pinToggle(dialog, "Unpin")).toBeEnabled();
  });
  click(pinToggle(dialog, "Unpin"));
  await waitFor(() => {
    expect(within(sidebar).getAllByTestId("pinned-agent-card")).toHaveLength(4);
    expect(rows()).toHaveLength(25);
  });
});

test("Refresh virtualization when unread indicators add an agent to the grid", async () => {
  mockThreads(120);
  const unreadAgentId = mockPinnedGrid();
  const indicators = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    await indicators.promise;
    return respond(200, { agents: { [unreadAgentId]: "unread" }, threads: {} });
  });
  mockViewportHeight(() => {
    return document.querySelectorAll('[data-testid="pinned-agent-card"]')
      .length > 4
      ? 360
      : 612;
  });
  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = screen.getByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    return expect(rows()).toHaveLength(25);
  });
  indicators.resolve(undefined);
  await waitFor(() => {
    expect(within(sidebar).getAllByTestId("pinned-agent-card")).toHaveLength(5);
    expect(rows()).toHaveLength(18);
  });
});

test("Refresh virtualization after collapsing and expanding the pinned section", async () => {
  mockThreads(120);
  context.mocks.browser.matchMedia(false);
  mockViewportHeight(() => {
    const header = document.querySelector(
      '[data-testid="pinned-section-header"]',
    );
    return header?.nextElementSibling ? 360 : 612;
  });
  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const header = screen.getByTestId("pinned-section-header");
  const rows = () => {
    return screen.getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    return expect(rows()).toHaveLength(18);
  });
  click(header);
  await waitFor(() => {
    return expect(rows()).toHaveLength(25);
  });
  click(header);
  await waitFor(() => {
    return expect(rows()).toHaveLength(18);
  });
});

test("Refresh virtualization when the upgrade card appears and disappears", async () => {
  mockThreads(120);
  let tier = "team";
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      showUsagePack: false,
      tier,
      ...billingPlanCapabilities(tier),
      credits: 10_000,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    });
  });
  mockViewportHeight(() => {
    return screen.queryByText("Get Pro") ? 360 : 612;
  });
  await setupPage({ context, path: `/chats/${threadId(0)}` });
  const sidebar = screen.getByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    return expect(rows()).toHaveLength(25);
  });
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("billing:changed"),
    ).toBeTruthy();
  });

  tier = "pro-suspend";
  context.mocks.ably.trigger("billing:changed");
  await within(sidebar).findByText("Get Pro");
  await waitFor(() => {
    return expect(rows()).toHaveLength(18);
  });

  tier = "team";
  context.mocks.ably.trigger("billing:changed");
  await waitFor(() => {
    expect(within(sidebar).queryByText("Get Pro")).not.toBeInTheDocument();
    expect(rows()).toHaveLength(25);
  });
});
