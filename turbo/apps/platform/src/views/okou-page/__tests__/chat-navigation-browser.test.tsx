import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";

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
  mockBrowserCdp(context, cdpUrl, {
    streaming: true,
    ...(initialSession?.window
      ? {
          targets: [
            {
              targetId: "example-page",
              title: "Example",
              url: "https://example.com",
              windowId: 0,
            },
            {
              targetId: "other-chat-page",
              title: "Other chat",
              url: "https://other.example.com",
              windowId: 1,
            },
          ],
        }
      : {}),
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
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

function openConversation(
  chatEvents: MockChatEventInput[],
  refined = false,
): Promise<void> {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Browser navigation",
    chatEvents,
  });
  return setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: refined },
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
  return screen.getByRole("complementary", { name: "Cloud browser" });
}

function visibleViewerMenu(
  _viewer: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  return screen.findByRole("menu", { name });
}

function menuRadio(menu: HTMLElement, name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitemradio", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error("Missing browser option: " + name);
  }
  return item;
}

async function openViewerSizingMenu(viewer: HTMLElement): Promise<HTMLElement> {
  click(buttonByName("Browser settings", viewer));
  const menu = await visibleViewerMenu(viewer, "Browser settings");
  click(within(menu).getByText("Window size"));
  return visibleViewerMenu(viewer, "Window size");
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
  await waitFor(() => {
    expect(address).toBeEnabled();
  });
  const viewer = within(sidebar).getByRole("region", {
    name: "Remote browser viewer",
  });
  const sizingMenu = await openViewerSizingMenu(viewer);
  expect(menuRadio(sizingMenu, "Follow panel")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  click(menuRadio(sizingMenu, "Off"));
  await waitFor(() => {
    expect(sizingMenu).not.toBeInTheDocument();
  });
  const updatedSizingMenu = await openViewerSizingMenu(viewer);
  expect(menuRadio(updatedSizingMenu, "Off")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  click(buttonByName("Browser settings", viewer));
  await waitFor(() => {
    expect(updatedSizingMenu).not.toBeInTheDocument();
  });
});

test.each(["https://viewer.example/live", null])(
  "The shared sidebar with provider liveUrl=%s operates its chat window and keeps it alive without input",
  async (liveUrl) => {
    mockWideScreen();
    const session: BrowserSession = {
      ...liveBrowserSession(),
      liveUrl,
      window: {
        instanceId: "22222222-2222-4222-8222-222222222222",
        primaryWindowId: 0,
      },
    };
    mockBrowserApi(session);
    const bodies: unknown[] = [];
    const entered = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const cancelled = context.mocks.deferred<void>();
    context.mocks.api(
      browserContract.leaseByThread,
      async ({ params, body, request, respond }) => {
        expect(params.threadId).toBe(session.threadId);
        bodies.push(body);
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await release.promise;
        return respond(200, { browser: session });
      },
    );
    await openConversation([]);
    await expectConversationReady();
    click(buttonByName("Open browser"));
    const sidebar = liveBrowserSidebar();
    await waitFor(() => {
      expect(
        within(sidebar).getByLabelText("Remote browser input"),
      ).toBeEnabled();
    });
    await entered.promise;
    expect(bodies).toStrictEqual([{}]);
    expect(
      queryAllByRoleFast("tab", sidebar).map((tab) => {
        return tab.getAttribute("aria-label");
      }),
    ).toStrictEqual(["Example"]);
    await fill(within(sidebar).getByLabelText("Address"), "next.example/path");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(within(sidebar).getByLabelText("Address")).toHaveValue(
        "http://next.example/path",
      );
    });
    await waitFor(() => {
      expect(
        within(sidebar).getByLabelText("Remote browser input"),
      ).toBeEnabled();
    });
    click(buttonByName("Close cloud browser", sidebar));
    await cancelled.promise;
    await waitFor(() => {
      expect(sidebar).not.toBeInTheDocument();
    });
  },
);

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
  await openConversation(completedConversationEvents(), true);
  await expectConversationReady();

  click(buttonByName("Open browser"));
  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  expect(within(sidebar).getByText("Browser not live")).toBeVisible();
  const start = buttonByName("Start browser", sidebar);
  expect(start).toBeEnabled();

  click(start);
  await expect(
    within(sidebar).findByDisplayValue("https://example.com"),
  ).resolves.toBeEnabled();

  click(buttonByName("Close cloud browser", liveBrowserSidebar()));
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
    screen.queryByRole("complementary", { name: "Cloud browser" }),
  ).toBeNull();
  click(card);

  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  expect(within(sidebar).getByText("Browser not live")).toBeVisible();
  expect(buttonByName("Start browser", sidebar)).toBeEnabled();
});

test("Take over the cloud browser from a working run and hand it back through the composer", async () => {
  mockWideScreen();
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  const browser = mockBrowserApi(liveBrowserSession());
  const runId = "d0000000-0000-4000-a000-000000000902";
  const previousRunId = "d0000000-0000-4000-a000-000000000901";
  const chatEvents: MockChatEventInput[] = [
    {
      id: "navigation-browser-previous-user",
      role: "user",
      content: "Research the release notes",
      runId: previousRunId,
      seqId: 1,
      createdAt: "2026-09-01T12:00:00.000Z",
    },
    {
      id: "navigation-browser-budget-input",
      eventType: "input.budget",
      role: "user",
      content: "Finish this run before its runtime limit",
      runId: undefined,
      seqId: 2,
      createdAt: "2026-09-01T12:00:01.000Z",
    },
    {
      id: "navigation-browser-previous-reply",
      role: "assistant",
      content: "I am checking the release notes now.",
      runId: previousRunId,
      seqId: 3,
      createdAt: "2026-09-01T12:00:02.000Z",
    },
    {
      id: "navigation-browser-previous-complete",
      role: "assistant",
      content: null,
      runId: previousRunId,
      runLifecycleEvent: "completed",
      seqId: 4,
      createdAt: "2026-09-01T12:00:03.000Z",
    },
    {
      id: "navigation-browser-live-user",
      role: "user",
      content: "Book a table for two",
      runId,
      seqId: 5,
      createdAt: "2026-09-01T12:00:04.000Z",
    },
  ];
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Browser navigation",
    chatEvents,
    activeRunIds: [runId],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });
  await expectConversationReady();
  click(buttonByName("Open browser"));
  const sidebar = liveBrowserSidebar();
  await within(sidebar).findByDisplayValue("https://example.com");
  const viewer = within(sidebar).getByRole("region", {
    name: "Remote browser viewer",
  });
  expect(
    within(viewer).getByLabelText("Open this browser in a new page"),
  ).toHaveAttribute("href", `/browsers/${THREAD_ID}`);
  await expect(
    within(viewer).findByText(/is working$/u),
  ).resolves.toBeInTheDocument();

  click(buttonByName("Take over", viewer));
  await expect(
    within(viewer).findByText("You're in control"),
  ).resolves.toBeInTheDocument();

  // An earlier Run's final output, budget declaration and usage can arrive late.
  act(() => {
    chatEvents.push(
      {
        id: "navigation-browser-previous-final-output",
        role: "assistant",
        content: "The release notes review is complete.",
        runId: previousRunId,
        seqId: 98,
        createdAt: "2026-09-01T12:00:58.000Z",
      },
      {
        id: "navigation-browser-previous-budget",
        eventType: "input.budget",
        role: "user",
        content: "Finish this run before its runtime limit",
        runId: previousRunId,
        revokesEventId: "navigation-browser-budget-input",
        seqId: 99,
        createdAt: "2026-09-01T12:00:59.000Z",
      },
      {
        id: "navigation-browser-previous-usage",
        role: "assistant",
        content: null,
        runId: previousRunId,
        seqId: 100,
        createdAt: "2026-09-01T12:01:00.000Z",
        usage: {
          version: 1,
          totalCredits: 7,
          settledAt: "2026-09-01T12:01:00.000Z",
          breakdown: [
            {
              kind: "model/gpt-6-luna/tokens.output",
              credits: 7,
              providers: [{ provider: "openai", credits: 7 }],
            },
          ],
        },
      },
    );
    createChatEvent(THREAD_ID);
  });
  await within(screen.getByRole("main")).findByText(
    "The release notes review is complete.",
  );
  expect(within(viewer).getByText("You're in control")).toBeInTheDocument();

  click(buttonByName("Hand back", viewer));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "I'm done in the browser. Please continue.",
    );
  });
  expect(within(sidebar).queryByText("You're in control")).toBeNull();
  click(buttonByName("Close cloud browser", viewer));
  await waitFor(() => {
    expect(sidebar).not.toBeInTheDocument();
  });
  expect(browser.closeRequests()).toBe(1);
});
