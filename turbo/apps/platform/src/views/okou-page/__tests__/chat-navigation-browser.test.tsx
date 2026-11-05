import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadComputerUseHostContract,
  chatThreadEventsContract,
  userMessageDocumentSchema,
} from "@okouai/api-contracts/contracts/chat-threads";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { initClient } from "@okouai/api-contracts/client/transport";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, vi } from "vitest";

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
  chatListEvent,
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000901";
const TAKE_OVER_MESSAGE =
  "I've taken over the browser. Don't use it until I hand it back.";
const HAND_BACK_MESSAGE = "I'm done in the browser. Please continue.";

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
  readonly native: ReturnType<typeof mockBrowserCdp>;
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
    currentSession = null;
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
  const native = mockBrowserCdp(context, cdpUrl, {
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
    if (!currentSession) {
      throw new Error("Expected an active browser for viewer connection");
    }
    return respond(200, {
      browser: currentSession,
      cdpUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
  });

  return {
    native,
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
  pwaNavigation = false,
  cloudBrowserEnabled = true,
): Promise<void> {
  mockChatLifecycle(context, {
    cloudBrowserEnabled,
    threadId: THREAD_ID,
    threadTitle: "Browser navigation",
    chatEvents,
  });
  return setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.CloudBrowserPanel]: refined,
      [FeatureSwitchKey.PwaNavigation]: pwaNavigation,
    },
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

test("An unauthorized Browser keeps its card and sidebar with an authorization placeholder", async () => {
  mockBrowserApi(liveBrowserSession());
  const events = completedConversationEvents().map((event) => {
    return event.id === "navigation-browser-reply"
      ? {
          ...event,
          content: `[Browser](https://app.okou.ai/browsers/${THREAD_ID})`,
        }
      : event;
  });
  await openConversation(events, true, false, false);
  await expectConversationReady();
  const card = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      "[data-browser-session-card]",
    );
    if (!element) {
      throw new Error("Browser card is not mounted");
    }
    return element;
  });
  click(card);
  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  expect(
    within(sidebar).getByText("Cloud browser is not enabled for this chat"),
  ).toBeInTheDocument();
  expect(
    within(sidebar).queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();
  expect(
    within(sidebar).queryByText("Browser not live"),
  ).not.toBeInTheDocument();
  expect(within(sidebar).getByLabelText("Close cloud browser")).toBeEnabled();
});

test("A committed Browser grant revalidates a denial from its optimistic update", async () => {
  const user = userEvent.setup({ delay: null });
  mockWideScreen();
  const session: BrowserSession = {
    ...liveBrowserSession(),
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 0,
    },
  };
  mockBrowserApi(session);
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    cloudBrowserEnabled: false,
    chatEvents: completedConversationEvents().map((event) => {
      return event.id === "navigation-browser-reply"
        ? {
            ...event,
            content: `[Browser](https://app.okou.ai/browsers/${THREAD_ID})`,
          }
        : event;
    }),
  });
  const agentId = "c0000000-0000-4000-a000-000000000001";
  const stream = installChatListStream(context, {
    caseId: 5313,
    snapshot: [chatListThread(1, "Browser grant", { id: THREAD_ID, agentId })],
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: [],
      vncHosts: [],
      computerUseHosts: [],
    });
  });
  const commit = context.mocks.deferred<void>();
  const deniedRead = context.mocks.deferred<void>();
  let committed = false;
  let enabling = false;
  context.mocks.api(browserContract.get, ({ respond }) => {
    if (!committed) {
      if (enabling) {
        deniedRead.resolve();
      }
      return respond(403, {
        error: {
          code: "BROWSER_AUTHORIZATION_REQUIRED",
          message: "Cloud browser is not enabled for this chat",
        },
      });
    }
    return respond(200, { browser: session });
  });
  context.mocks.api(
    chatThreadComputerUseHostContract.update,
    async ({ body, respond }) => {
      if (!body.eventId || body.cloudBrowserEnabled !== true) {
        throw new Error("Expected an identified Browser grant");
      }
      await commit.promise;
      committed = true;
      stream.setEvents([
        chatListEvent(5313, 2, "computer_use_host_updated", THREAD_ID, {
          id: body.eventId,
          agentId,
          cloudBrowserEnabled: true,
        }),
      ]);
      context.mocks.ably.trigger("threadListChanged");
      return respond(204);
    },
  );
  const hold = context.mocks.deferred<void>();
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    await hold.promise;
    return respond(200, { browser: session });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.CloudBrowserPanel]: true,
      [FeatureSwitchKey.BrowserSharedOwner]: true,
    },
  });
  await expectConversationReady();
  click(
    await waitFor(() => {
      return buttonByName("Open");
    }),
  );
  const sidebar = liveBrowserSidebar();
  await within(sidebar).findByText(
    "Cloud browser is not enabled for this chat",
  );
  click(buttonByName("Connectors"));
  enabling = true;
  await user.click(
    await screen.findByRole("switch", {
      name: "Cloud browser",
      checked: false,
    }),
  );
  await deniedRead.promise;
  expect(
    screen.getByRole("switch", { name: "Cloud browser", checked: true }),
  ).toBeChecked();
  commit.resolve();
  await waitFor(() => {
    expect(
      within(sidebar).getByLabelText("Remote browser input"),
    ).toBeEnabled();
  });
  expect(
    within(sidebar).queryByText("Cloud browser is not enabled for this chat"),
  ).not.toBeInTheDocument();
});

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
    const address = within(sidebar).getByLabelText<HTMLInputElement>("Address");
    await fill(address, "next.example/path");
    fireEvent.submit(address.form!);
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

test("Resizing the browser sidebar synchronizes the remote display to the committed panel", async () => {
  mockWideScreen();
  let canvasBox = new DOMRect(0, 0, 900, 600);
  let resizeContainer: HTMLElement | null = null;
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this instanceof HTMLCanvasElement) {
        return canvasBox;
      }
      return this === resizeContainer
        ? new DOMRect(0, 0, 1440, 900)
        : original.call(this);
    },
  );
  const { native } = mockBrowserApi(liveBrowserSession());
  await openConversation([]);
  await expectConversationReady();
  click(buttonByName("Open browser"));
  await waitFor(() => {
    expect(native.viewport).toStrictEqual({ width: 900, height: 600 });
  });
  act(() => {
    native.frame("AAAA");
  });
  const handle = await screen.findByRole("separator", {
    name: "Resize sidebar",
  });
  resizeContainer = handle.parentElement;

  // The committed wider panel gives the canvas its new box.
  canvasBox = new DOMRect(0, 0, 916, 600);
  handle.focus();
  await userEvent.keyboard("{ArrowLeft}");

  await waitFor(() => {
    expect(native.viewport).toStrictEqual({ width: 916, height: 600 });
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

test("The chat browser sidebar forwards a touch tap exactly once", async () => {
  mockWideScreen();
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this instanceof HTMLCanvasElement
        ? new DOMRect(0, 0, 1440, 900)
        : original.call(this);
    },
  );
  const { native } = mockBrowserApi(liveBrowserSession());
  await openConversation([]);
  await expectConversationReady();
  click(buttonByName("Open browser"));
  const input = await within(liveBrowserSidebar()).findByLabelText(
    "Remote browser input",
  );
  await waitFor(() => {
    return expect(input).toBeEnabled();
  });
  const surface = within(liveBrowserSidebar()).getByRole("img", {
    name: "Live browser view",
  }).parentElement!;
  for (const type of ["pointerdown", "pointerup"]) {
    fireEvent(
      surface,
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        pointerId: 5,
        isPrimary: true,
        clientX: 720,
        clientY: 450,
      }),
    );
  }
  await waitFor(() => {
    return expect(native.input).toHaveLength(2);
  });
  expect(native.input).toStrictEqual([
    expect.objectContaining({
      params: expect.objectContaining({ type: "mousePressed", x: 720, y: 450 }),
    }),
    expect.objectContaining({
      params: expect.objectContaining({
        type: "mouseReleased",
        x: 720,
        y: 450,
      }),
    }),
  ]);
});

test.each([
  { pwaNavigation: false, active: false },
  { pwaNavigation: false, active: true },
  { pwaNavigation: true, active: false },
  { pwaNavigation: true, active: true },
])(
  "Open the mobile chat browser and return to the conversation (PWA=$pwaNavigation, active=$active)",
  async ({ pwaNavigation, active }) => {
    context.mocks.browser.matchMedia((query) => {
      return query === "(display-mode: standalone)" && pwaNavigation;
    });
    mockBrowserApi(active ? liveBrowserSession() : null);
    await openConversation(completedConversationEvents(), true, pwaNavigation);
    await expectConversationReady();

    click(buttonByName("More actions"));
    const menu = await screen.findByRole("menu");
    const opener = await waitFor(() => {
      const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
        return candidate.textContent?.trim() === "Open browser";
      });
      if (!item) {
        throw new Error("Browser menu item is missing");
      }
      expect(item).not.toHaveAttribute("aria-disabled", "true");
      return item;
    });
    click(opener);

    const sidebar = await screen.findByRole("complementary", {
      name: "Cloud browser",
    });
    expect(buttonByName("More actions")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    if (!active) {
      const start = await waitFor(() => {
        return buttonByName("Start browser", sidebar);
      });
      click(start);
    }
    await expect(
      within(sidebar).findByDisplayValue("https://example.com"),
    ).resolves.toBeEnabled();

    click(buttonByName("Close cloud browser", sidebar));
    await waitFor(() => {
      expect(sidebar).not.toBeInTheDocument();
    });
    expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  },
);

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

  const retiredInput = within(sidebar).getByLabelText("Remote browser input");
  click(buttonByName("Close cloud browser", liveBrowserSidebar()));
  await waitFor(() => {
    expect(sidebar).not.toBeInTheDocument();
  });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(browser.closeRequests()).toBe(1);

  click(buttonByName("Open browser"));
  const reopened = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  click(buttonByName("Start browser", reopened));
  const input = await waitFor(() => {
    const currentInput = within(reopened).getByLabelText(
      "Remote browser input",
    );
    expect(currentInput).toBeEnabled();
    return currentInput;
  });
  fireEvent.input(retiredInput, {
    target: { value: "retired surface" },
    data: "retired surface",
    inputType: "insertText",
  });
  fireEvent.submit(retiredInput.closest("form")!);
  fireEvent(
    retiredInput,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "reopened surface" },
    data: "reopened surface",
    inputType: "insertText",
  });
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => {
    expect(browser.native.input).toContainEqual({
      method: "Input.insertText",
      params: { text: "reopened surface" },
      sessionId: browser.native.pageSession("example-page"),
    });
  });
  expect(browser.native.input).not.toContainEqual(
    expect.objectContaining({
      method: "Input.insertText",
      params: { text: "retired surface" },
    }),
  );
  await waitFor(() => {
    expect(
      browser.native.input.filter((request) => {
        return request.method === "Input.dispatchKeyEvent";
      }),
    ).toStrictEqual([
      {
        method: "Input.dispatchKeyEvent",
        sessionId: browser.native.pageSession("example-page"),
        params: expect.objectContaining({
          type: "rawKeyDown",
          key: "Backspace",
        }),
      },
      {
        method: "Input.dispatchKeyEvent",
        sessionId: browser.native.pageSession("example-page"),
        params: expect.objectContaining({ type: "keyUp", key: "Backspace" }),
      },
      {
        method: "Input.dispatchKeyEvent",
        sessionId: browser.native.pageSession("example-page"),
        params: expect.objectContaining({
          type: "keyDown",
          key: "Enter",
          text: "\r",
        }),
      },
      {
        method: "Input.dispatchKeyEvent",
        sessionId: browser.native.pageSession("example-page"),
        params: expect.objectContaining({ type: "keyUp", key: "Enter" }),
      },
    ]);
  });
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

test("Take over the cloud browser without stopping the working run and hand it back", async () => {
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
  const takeOverAccepted = createDeferredPromise<void>(context.signal);
  mockChatLifecycle(context, {
    cloudBrowserEnabled: true,
    threadId: THREAD_ID,
    threadTitle: "Browser navigation",
    chatEvents,
    activeRunIds: [runId],
    appendGate: takeOverAccepted.promise,
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
  await expect(
    screen.findByText(TAKE_OVER_MESSAGE),
  ).resolves.toBeInTheDocument();
  // Handing back before the Run has been told could reach it first.
  expect(buttonByName("Hand back", viewer)).toBeDisabled();
  takeOverAccepted.resolve();
  await waitFor(() => {
    expect(buttonByName("Hand back", viewer)).toBeEnabled();
  });

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
  // The Run kept working, so the continue message is steered into it.
  await expect(
    screen.findByText(HAND_BACK_MESSAGE),
  ).resolves.toBeInTheDocument();
  await expect(
    within(viewer).findByText(/is working$/u),
  ).resolves.toBeInTheDocument();
  click(buttonByName("Close cloud browser", viewer));
  await waitFor(() => {
    expect(sidebar).not.toBeInTheDocument();
  });
  expect(browser.closeRequests()).toBe(1);
});

function mockLivePageGeometry(
  box: () => DOMRect = () => {
    return new DOMRect(0, 0, 1440, 900);
  },
): void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this instanceof HTMLCanvasElement ? box() : original.call(this);
    },
  );
}

async function livePage(viewer: HTMLElement): Promise<{
  readonly view: HTMLElement;
  readonly input: HTMLInputElement;
}> {
  await waitFor(() => {
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  return {
    view: within(viewer).getByRole("img", { name: "Live browser view" }),
    input: within(viewer).getByRole<HTMLInputElement>("textbox", {
      name: "Remote browser input",
    }),
  };
}

test.each(["mouse", "keyboard", "composition", "touch"] as const)(
  "Accepted %s input on the live page takes the cloud browser over from a working run",
  async (inputKind) => {
    mockWideScreen();
    mockLivePageGeometry();
    mockBrowserApi(liveBrowserSession());
    const runId = "d0000000-0000-4000-a000-000000000903";
    mockChatLifecycle(context, {
      cloudBrowserEnabled: true,
      threadId: THREAD_ID,
      threadTitle: "Browser navigation",
      chatEvents: [
        {
          id: "page-input-live-user",
          role: "user",
          content: "Compare the two pricing pages",
          runId,
          seqId: 1,
          createdAt: "2026-09-01T12:00:00.000Z",
        },
      ],
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
    await expect(
      within(viewer).findByText(/is working$/u),
    ).resolves.toBeInTheDocument();
    const page = await livePage(viewer);

    // Rejected pointer input, composition keys and focus release are local only.
    fireEvent.pointerDown(page.view, { pointerType: "pen", button: 0 });
    fireEvent.keyDown(page.input, { key: "Process", keyCode: 229 });
    fireEvent.keyDown(page.input, { key: "F8" });
    expect(within(viewer).getByText(/is working$/u)).toBeInTheDocument();
    expect(screen.queryByText(TAKE_OVER_MESSAGE)).toBeNull();

    // Focus without a preceding remote mouse press.
    act(() => {
      page.input.focus();
    });
    expect(page.input).toHaveFocus();
    fireEvent.compositionStart(page.input);
    // Native composition ownership suppresses even an unmarked confirmation key.
    fireEvent.keyDown(page.input, { key: "Enter", code: "Enter" });
    expect(within(viewer).getByText(/is working$/u)).toBeInTheDocument();
    fireEvent(
      page.input,
      Object.assign(new Event("compositionend", { bubbles: true }), {
        data: "",
      }),
    );

    if (inputKind === "mouse") {
      await userEvent.pointer({
        target: page.view,
        keys: "[MouseLeft]",
        coords: { clientX: 720, clientY: 450 },
      });
    } else if (inputKind === "touch") {
      for (const type of ["pointerdown", "pointerup"]) {
        fireEvent(
          page.view,
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
            pointerId: 5,
            isPrimary: true,
            clientX: 720,
            clientY: 450,
          }),
        );
      }
    } else {
      if (inputKind === "keyboard") {
        await userEvent.keyboard("a");
      } else {
        fireEvent.compositionStart(page.input);
        fireEvent.input(page.input, {
          target: { value: "你好" },
          inputType: "insertCompositionText",
          isComposing: true,
        });
        fireEvent(
          page.input,
          Object.assign(new Event("compositionend", { bubbles: true }), {
            data: "你好",
          }),
        );
        fireEvent.input(page.input, {
          target: { value: "你好" },
          inputType: "insertCompositionText",
        });
      }
    }
    await expect(
      within(viewer).findByText("You're in control"),
    ).resolves.toBeInTheDocument();
    await userEvent.click(page.input);
    await userEvent.keyboard("b");
    await expect(
      screen.findByText(TAKE_OVER_MESSAGE),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(buttonByName("Hand back", viewer)).toBeEnabled();
    });
    click(buttonByName("Hand back", viewer));
    await expect(
      screen.findByText(HAND_BACK_MESSAGE),
    ).resolves.toBeInTheDocument();
    // Repeated accepted input sent one notification, and the Run kept working.
    expect(screen.getAllByText(TAKE_OVER_MESSAGE)).toHaveLength(1);
    await expect(
      within(viewer).findByText(/is working$/u),
    ).resolves.toBeInTheDocument();
  },
);

test.each([true, false])(
  "Page-input takeover ignores letterboxing and respects the Lab switch (%s)",
  async (refined) => {
    mockWideScreen();
    let box = new DOMRect(0, 0, 1440, 900);
    mockLivePageGeometry(() => {
      return box;
    });
    const { native } = mockBrowserApi(liveBrowserSession());
    const runId = "d0000000-0000-4000-a000-000000000905";
    mockChatLifecycle(context, {
      cloudBrowserEnabled: true,
      threadId: THREAD_ID,
      threadTitle: "Browser navigation",
      chatEvents: [
        {
          id: "page-input-guard-user",
          role: "user",
          content: "Compare these pages",
          runId,
          seqId: 1,
          createdAt: "2026-09-01T12:00:00.000Z",
        },
      ],
      activeRunIds: [runId],
    });
    await setupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: refined },
    });
    await expectConversationReady();
    click(buttonByName("Open browser"));
    const sidebar = liveBrowserSidebar();
    await within(sidebar).findByDisplayValue("https://example.com");
    const viewer = within(sidebar).getByRole("region", {
      name: "Remote browser viewer",
    });
    const page = await livePage(viewer);
    const menu = await openViewerSizingMenu(viewer);
    click(menuRadio(menu, "Off"));
    await waitFor(() => {
      expect(menu).not.toBeInTheDocument();
    });
    // A taller panel letterboxes the unchanged remote image.
    box = new DOMRect(0, 0, 1440, 1800);
    await userEvent.pointer({
      target: page.view,
      keys: "[MouseLeft]",
      coords: { clientX: 720, clientY: 10 },
    });
    expect(screen.queryByText(TAKE_OVER_MESSAGE)).toBeNull();
    expect(within(viewer).queryByText(/is working$/u) !== null).toBe(refined);
    await userEvent.click(page.input);
    await userEvent.keyboard("x");
    await waitFor(() => {
      expect(native.input).toContainEqual(
        expect.objectContaining({
          method: "Input.dispatchKeyEvent",
          params: expect.objectContaining({ type: "keyDown", text: "x" }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryAllByText(TAKE_OVER_MESSAGE)).toHaveLength(
        refined ? 1 : 0,
      );
    });
    expect(within(viewer).queryByText("You're in control") !== null).toBe(
      refined,
    );
  },
);

test("A delayed handback cannot clear a newer run's page-input takeover", async () => {
  mockWideScreen();
  mockLivePageGeometry();
  mockBrowserApi(liveBrowserSession());
  const runId = "d0000000-0000-4000-a000-000000000906";
  const newerRunId = "d0000000-0000-4000-a000-000000000907";
  const chatEvents: MockChatEventInput[] = [
    {
      id: "delayed-handback-user",
      role: "user",
      content: "Compare these pages",
      runId,
      seqId: 1,
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  ];
  const handBackStarted = createDeferredPromise<void>(context.signal);
  const handBackAccepted = createDeferredPromise<void>(context.signal);
  const lifecycle = {
    threadId: THREAD_ID,
    threadTitle: "Browser navigation",
    chatEvents,
    activeRunIds: [runId],
    appendGate: Promise.resolve(),
    onQueuedEventAppend: ({ content }: { content?: string }) => {
      if (content === HAND_BACK_MESSAGE && !handBackStarted.settled()) {
        handBackStarted.resolve();
      }
    },
  };
  mockChatLifecycle(context, { ...lifecycle, cloudBrowserEnabled: true });
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
  const page = await livePage(viewer);
  click(buttonByName("Take over", viewer));
  await waitFor(() => {
    expect(buttonByName("Hand back", viewer)).toBeEnabled();
  });

  lifecycle.appendGate = handBackAccepted.promise;
  click(buttonByName("Hand back", viewer));
  await handBackStarted.promise;
  expect(buttonByName("Hand back", viewer)).toBeDisabled();

  // Realtime can expose a newer Run before the earlier HTTP send settles.
  act(() => {
    chatEvents.push(
      {
        id: "delayed-handback-complete",
        role: "assistant",
        content: null,
        runId,
        runLifecycleEvent: "completed",
        seqId: 100,
        createdAt: "2026-09-01T12:01:40.000Z",
      },
      {
        id: "delayed-handback-new-run",
        role: "user",
        content: "Continue the comparison",
        runId: newerRunId,
        seqId: 101,
        createdAt: "2026-09-01T12:01:41.000Z",
      },
    );
    lifecycle.activeRunIds.push(newerRunId);
    createChatEvent(THREAD_ID);
  });
  await within(viewer).findByText(/is working$/u);

  // A new takeover is independent of the old handback still in flight.
  lifecycle.appendGate = Promise.resolve();
  await userEvent.pointer({
    target: page.view,
    keys: "[MouseLeft]",
    coords: { clientX: 720, clientY: 450 },
  });
  await within(viewer).findByText("You're in control");
  // Local ownership moves immediately, but its notice waits for the older send.
  expect(screen.getAllByText(TAKE_OVER_MESSAGE)).toHaveLength(1);
  handBackAccepted.resolve();
  await waitFor(() => {
    expect(buttonByName("Hand back", viewer)).toBeEnabled();
  });

  // Read the public event tail, not optimistic UI or request invocation order.
  const events = await initClient(chatThreadEventsContract, {
    baseUrl: "https://api.okou.ai",
  }).rows({
    params: { threadId: THREAD_ID },
    query: chatThreadEventsContract.rows.query.parse({ sinceSeqId: 0 }),
    fetchOptions: { signal: context.signal },
  });
  expect(events.status).toBe(200);
  if (events.status !== 200) {
    throw new Error("Expected the persisted handoff events");
  }
  expect(
    events.body.rows
      .filter((row) => {
        return row.eventType === "input.prompt" && row.runId === null;
      })
      .map((row) => {
        return userMessageDocumentSchema
          .parse(row.payload?.userMessage)
          .parts.flatMap((part) => {
            return part.type === "text" ? [part.text] : [];
          })
          .join("");
      }),
  ).toStrictEqual([TAKE_OVER_MESSAGE, HAND_BACK_MESSAGE, TAKE_OVER_MESSAGE]);
  expect(within(viewer).getByText("You're in control")).toBeInTheDocument();
});

test("A failed handback does not poison the next explicit handback", async () => {
  mockWideScreen();
  mockBrowserApi(liveBrowserSession());
  const runId = "d0000000-0000-4000-a000-000000000908";
  const rejected = createDeferredPromise<void>(context.signal);
  mockChatLifecycle(context, {
    cloudBrowserEnabled: true,
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "retry-handback-user",
        role: "user",
        content: "Compare these pages",
        runId,
        seqId: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
    ],
    activeRunIds: [runId],
    onQueuedEventAppend: ({ content }) => {
      if (content === HAND_BACK_MESSAGE && !rejected.settled()) {
        rejected.resolve();
        throw new Error("The first handback request failed");
      }
    },
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
  click(buttonByName("Take over", viewer));
  await waitFor(() => {
    expect(buttonByName("Hand back", viewer)).toBeEnabled();
  });

  click(buttonByName("Hand back", viewer));
  await rejected.promise;
  await waitFor(() => {
    expect(buttonByName("Hand back", viewer)).toBeEnabled();
  });
  expect(within(viewer).getByText("You're in control")).toBeInTheDocument();

  click(buttonByName("Hand back", viewer));
  await within(viewer).findByText(/is working$/u);
});

test("Hand back after using the cloud browser between runs continues in one step", async () => {
  mockWideScreen();
  mockLivePageGeometry();
  mockBrowserApi(liveBrowserSession());
  const runId = "d0000000-0000-4000-a000-000000000904";
  mockChatLifecycle(context, {
    cloudBrowserEnabled: true,
    threadId: THREAD_ID,
    threadTitle: "Browser navigation",
    chatEvents: [
      {
        id: "between-runs-user",
        role: "user",
        content: "Download last month's invoices",
        runId,
        seqId: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      {
        id: "between-runs-reply",
        role: "assistant",
        content: "Please sign in to the billing site in the browser.",
        runId,
        seqId: 2,
        createdAt: "2026-09-01T12:00:01.000Z",
      },
      {
        id: "between-runs-complete",
        role: "assistant",
        content: null,
        runId,
        runLifecycleEvent: "completed",
        seqId: 3,
        createdAt: "2026-09-01T12:00:02.000Z",
      },
    ],
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
  expect(within(viewer).queryByText("You're in control")).toBeNull();

  // Nobody is driving, so signing in tells no Run anything.
  const page = await livePage(viewer);
  await userEvent.pointer({
    target: page.view,
    keys: "[MouseLeft]",
    coords: { clientX: 720, clientY: 450 },
  });
  await expect(
    within(viewer).findByText("You're in control"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(TAKE_OVER_MESSAGE)).toBeNull();

  click(buttonByName("Hand back", viewer));
  await expect(
    screen.findByText(HAND_BACK_MESSAGE),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(TAKE_OVER_MESSAGE)).toBeNull();
  await expect(
    within(viewer).findByText(/is working$/u),
  ).resolves.toBeInTheDocument();
});
