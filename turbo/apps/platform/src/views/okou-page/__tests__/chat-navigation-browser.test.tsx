import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { mockBrowserCdp } from "../../../__tests__/browser-cdp-fixture.ts";

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000901";

function liveBrowserSession(): BrowserSession {
  return {
    threadId: THREAD_ID,
    name: "research",
    status: "active",
    viewerUrl: `https://viewer.example.test/browsers/${THREAD_ID}`,
    liveUrl: "https://viewer.example.test/live/research",
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    screen: { width: 1440, height: 900, resizable: true },
    idleExpiresAt: "2026-09-01T12:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
}

interface BrowserApiControl {
  readonly closeRequests: () => number;
}

function mockBrowserApi(
  initialSession: BrowserSession | null,
): BrowserApiControl {
  let currentSession = initialSession;
  let closeRequestCount = 0;

  context.mocks.api(browserContract.get, ({ respond }) => {
    return currentSession === null
      ? respond(404, {
          error: {
            code: "BROWSER_NOT_FOUND",
            message: "Managed browser not found",
          },
        })
      : respond(200, { browser: currentSession });
  });
  context.mocks.api(browserContract.open, ({ respond }) => {
    currentSession = liveBrowserSession();
    return respond(200, { browser: currentSession });
  });
  context.mocks.api(browserContract.close, ({ respond }) => {
    closeRequestCount += 1;
    return respond(200, {});
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return currentSession === null
      ? respond(404, {
          error: {
            code: "BROWSER_NOT_FOUND",
            message: "Managed browser not found",
          },
        })
      : respond(200, { browser: currentSession });
  });
  const cdpUrl = "wss://cdp.browser-use.com/sidebar";
  mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl });
  });

  return {
    closeRequests: () => {
      return closeRequestCount;
    },
  };
}

function completedConversationEvents(): MockChatEventInput[] {
  return [
    {
      id: "navigation-browser-user",
      role: "user",
      content: "Research the release notes",
      runId: "navigation-browser-run",
      seqId: 1,
      createdAt: "2026-09-01T12:00:00.000Z",
    },
    {
      id: "navigation-browser-reply",
      role: "assistant",
      content: "I am checking the release notes now.",
      runId: "navigation-browser-run",
      seqId: 2,
      createdAt: "2026-09-01T12:00:01.000Z",
    },
    {
      id: "navigation-browser-complete",
      role: "assistant",
      content: null,
      runId: "navigation-browser-run",
      runLifecycleEvent: "completed",
      seqId: 3,
      createdAt: "2026-09-01T12:00:02.000Z",
    },
  ];
}

function mockWideScreen(): void {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
}

function openConversation(chatEvents: MockChatEventInput[]): Promise<void> {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Browser navigation",
    chatEvents,
  });
  return setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
}

async function expectConversationReady(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  });
  await waitFor(() => {
    expect(
      document.querySelector("[data-chat-skeleton]"),
    ).not.toBeInTheDocument();
  });
}

function queryButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLButtonElement | null {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  return button instanceof HTMLButtonElement ? button : null;
}

function buttonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLButtonElement {
  const button = queryButtonByName(name, container);
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function liveBrowserSidebar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Live browser" });
}

function visibleViewerMenu(
  viewer: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  return waitFor(() => {
    const menus = Array.from(
      viewer.querySelectorAll<HTMLElement>('[role="menu"]'),
    ).filter((menu) => {
      return menu.getAttribute("aria-label") === name;
    });
    const [menu] = menus;
    if (!menu || menus.length !== 1) {
      throw new Error(`Expected one viewer menu named "${name}"`);
    }
    expect(menu).toBeVisible();
    expect(menu.closest('[aria-hidden="true"], [hidden], [inert]')).toBeNull();
    return menu;
  });
}

async function openViewerSizingMenu(viewer: HTMLElement): Promise<HTMLElement> {
  click(buttonByName("Browser menu", viewer));
  const menu = await visibleViewerMenu(viewer, "Browser menu");
  click(within(menu).getByText("Fit to this viewer"));
  return visibleViewerMenu(viewer, "Fit to this viewer");
}

test("The embedded Okou viewer retains its sizing preference when the menu reopens", async () => {
  mockWideScreen();
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  mockBrowserApi(liveBrowserSession());
  await openConversation([]);
  await expectConversationReady();
  click(buttonByName("Open browser"));
  const sidebar = liveBrowserSidebar();
  const address = await within(sidebar).findByDisplayValue(
    "https://example.com",
  );
  expect(address).toBeEnabled();
  const viewer = within(sidebar).getByRole("region", {
    name: "Remote browser viewer",
  });
  const sizingMenu = await openViewerSizingMenu(viewer);
  expect(within(sizingMenu).getByText("Sync continuously")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  click(within(sizingMenu).getByText("Do not sync automatically"));
  await waitFor(() => {
    expect(sizingMenu).not.toBeInTheDocument();
  });
  const updatedSizingMenu = await openViewerSizingMenu(viewer);
  expect(
    within(updatedSizingMenu).getByText("Do not sync automatically"),
  ).toHaveAttribute("aria-checked", "true");
  click(buttonByName("Browser menu", viewer));
  await waitFor(() => {
    expect(updatedSizingMenu).not.toBeInTheDocument();
  });
});

test("The embedded Okou viewer owns its shortcuts while the conversation keeps its shortcuts", async () => {
  const user = userEvent.setup({ delay: null });
  mockWideScreen();
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  mockBrowserApi(liveBrowserSession());
  await openConversation(completedConversationEvents());
  await expectConversationReady();
  click(buttonByName("Open browser"));
  const address = await screen.findByDisplayValue("https://example.com");
  expect(address).toBeEnabled();
  await user.click(address);
  expect(address).toHaveFocus();
  await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
  expect(
    screen.queryByRole("dialog", { name: "Search workspace..." }),
  ).not.toBeInTheDocument();
  const message = screen.getByRole("textbox", { name: "Message" });
  await user.click(message);
  expect(message).toHaveFocus();
  await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
  await expect(
    screen.findByRole("dialog", { name: "Search workspace..." }),
  ).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(message).toHaveFocus();
  });
});

test("Start and close a browser from the thread sidebar", async () => {
  mockWideScreen();
  const browser = mockBrowserApi(null);
  await openConversation(completedConversationEvents());
  await expectConversationReady();

  click(buttonByName("Open browser"));
  const sidebar = await screen.findByRole("complementary", {
    name: "Live browser",
  });
  expect(within(sidebar).getByText("Browser not live")).toBeVisible();
  const start = buttonByName("Start browser", sidebar);
  expect(start).toBeEnabled();

  click(start);
  await expect(
    within(sidebar).findByDisplayValue("https://example.com"),
  ).resolves.toBeEnabled();

  click(buttonByName("Close live browser", liveBrowserSidebar()));
  await waitFor(() => {
    expect(sidebar).not.toBeInTheDocument();
  });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(browser.closeRequests()).toBe(1);
});

test("Open a stopped browser card and offer a new session", async () => {
  mockWideScreen();
  mockBrowserApi(null);
  await openConversation([
    {
      id: "stopped-browser-card",
      role: "assistant",
      content: `The prior browser is available here: /browsers/${THREAD_ID}`,
      runId: "stopped-browser-run",
      seqId: 1,
      createdAt: "2026-09-01T12:00:00.000Z",
    },
    {
      id: "stopped-browser-complete",
      eventType: "run.completed",
      content: null,
      runId: "stopped-browser-run",
      seqId: 2,
      createdAt: "2026-09-01T12:00:01.000Z",
    },
  ]);

  const stoppedLabel = await screen.findByText("Stopped");
  const card = stoppedLabel.closest("button");
  if (!(card instanceof HTMLButtonElement)) {
    throw new Error("Stopped browser card is not actionable");
  }
  expect(card).toHaveTextContent("Stopped");
  expect(
    screen.queryByRole("complementary", { name: "Live browser" }),
  ).toBeNull();
  click(card);

  const sidebar = await screen.findByRole("complementary", {
    name: "Live browser",
  });
  expect(within(sidebar).getByText("Browser not live")).toBeVisible();
  expect(buttonByName("Start browser", sidebar)).toBeEnabled();
});
