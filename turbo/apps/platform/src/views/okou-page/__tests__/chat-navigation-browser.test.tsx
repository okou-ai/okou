import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, screen, waitFor, within } from "@testing-library/react";
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

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000901";
const LIVE_BROWSER_TITLE = "Live browser: research";

function liveBrowserSession(
  overrides: Partial<BrowserSession> = {},
): BrowserSession {
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
    ...overrides,
  };
}

interface BrowserApiControl {
  readonly closeRequests: () => number;
  readonly endBeforeNextResize: () => void;
  readonly liveSessionWasRead: () => boolean;
  readonly resizeAspectRatios: () => readonly number[];
  readonly setSession: (session: BrowserSession | null) => void;
}

function mockBrowserApi(
  initialSession: BrowserSession | null,
): BrowserApiControl {
  let currentSession = initialSession;
  let latestReadSession: BrowserSession | null = null;
  let closeRequestCount = 0;
  let resizeWillMiss = false;
  const resizeRequests: number[] = [];

  context.mocks.api(browserContract.get, ({ respond }) => {
    latestReadSession = currentSession;
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
  context.mocks.api(browserContract.resizeByThread, ({ body, respond }) => {
    resizeRequests.push(body.aspectRatio);
    if (resizeWillMiss || currentSession === null) {
      resizeWillMiss = false;
      currentSession = null;
      return respond(404, {
        error: {
          code: "BROWSER_NOT_FOUND",
          message: "Managed browser not found",
        },
      });
    }
    currentSession = liveBrowserSession({
      screen: {
        width: 1440,
        height: Math.round(1440 / body.aspectRatio),
        resizable: true,
      },
      updatedAt: "2026-09-01T12:01:00.000Z",
    });
    return respond(200, { browser: currentSession });
  });

  return {
    closeRequests: () => {
      return closeRequestCount;
    },
    endBeforeNextResize: () => {
      resizeWillMiss = true;
    },
    liveSessionWasRead: () => {
      return latestReadSession?.status === "active";
    },
    resizeAspectRatios: () => {
      return resizeRequests;
    },
    setSession: (session) => {
      currentSession = session;
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

interface ViewportGeometry {
  readonly resizeTo: (width: number, height: number) => void;
}

function installViewportGeometry(
  viewport: HTMLElement,
  initialWidth: number,
  initialHeight: number,
): ViewportGeometry {
  const descriptor = Object.getOwnPropertyDescriptor(
    viewport,
    "getBoundingClientRect",
  );
  let width = initialWidth;
  let height = initialHeight;
  Object.defineProperty(viewport, "getBoundingClientRect", {
    configurable: true,
    value: (): DOMRect => {
      return {
        bottom: height,
        height,
        left: 0,
        right: width,
        toJSON: () => {
          return {};
        },
        top: 0,
        width,
        x: 0,
        y: 0,
      } as DOMRect;
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(viewport, "getBoundingClientRect", descriptor);
        return;
      }
      Reflect.deleteProperty(viewport, "getBoundingClientRect");
    },
    { once: true },
  );
  return {
    resizeTo: (nextWidth, nextHeight) => {
      width = nextWidth;
      height = nextHeight;
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
    },
  };
}

test("Fit a live browser when the available sidebar space changes", async () => {
  mockWideScreen();
  const browser = mockBrowserApi(liveBrowserSession());
  await openConversation(completedConversationEvents());
  await expectConversationReady();

  click(buttonByName("Open browser"));
  const liveFrame = await screen.findByTitle(LIVE_BROWSER_TITLE);
  expect(liveFrame).toBeVisible();
  const viewport = document.querySelector<HTMLElement>(
    "[data-browser-session-viewport]",
  );
  if (!viewport) {
    throw new Error("Live browser viewport is not mounted");
  }
  const geometry = installViewportGeometry(viewport, 600, 600);
  geometry.resizeTo(600, 600);

  const fit = await waitFor(() => {
    return buttonByName("Fit browser to window");
  });
  expect(fit).toBeVisible();
  click(fit);

  await waitFor(() => {
    expect(browser.resizeAspectRatios()).toStrictEqual([1]);
    expect(queryButtonByName("Fit browser to window")).toBeNull();
  });

  geometry.resizeTo(800, 600);
  const fitAfterResize = await waitFor(() => {
    return buttonByName("Fit browser to window");
  });
  browser.endBeforeNextResize();
  click(fitAfterResize);

  await waitFor(() => {
    expect(browser.resizeAspectRatios()).toStrictEqual([1, 4 / 3]);
  });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(screen.queryByText("Browser unavailable")).toBeNull();
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
  await expect(screen.findByTitle(LIVE_BROWSER_TITLE)).resolves.toBeVisible();

  click(buttonByName("Close live browser", liveBrowserSidebar()));
  await waitFor(() => {
    expect(screen.queryByTitle(LIVE_BROWSER_TITLE)).toBeNull();
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
