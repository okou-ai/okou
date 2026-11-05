import {
  browserContract,
  type BrowserSession,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListStream,
} from "../../okou-page/__tests__/chat-list-test-helpers.ts";

const context = testContext();
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const AUTHORIZATION_REQUIRED = "Cloud browser is not enabled for this chat";

function mockChatAuthorization(enabled: boolean) {
  const events: ReturnType<typeof chatListEvent>[] = [];
  const snapshot = [
    chatListThread(1, "Browser authorization", {
      id: THREAD_ID,
      cloudBrowserEnabled: enabled,
    }),
  ];
  const stream = installChatListStream(context, {
    caseId: 5312,
    snapshot,
  });
  const authorize = (authorized: boolean) => {
    events.push(
      chatListEvent(
        5312,
        events.length + 2,
        "computer_use_host_updated",
        THREAD_ID,
        {
          cloudBrowserEnabled: authorized,
        },
      ),
    );
    stream.setEvents(events);
    context.mocks.ably.trigger("threadListChanged");
  };
  return {
    authorize,
    cachedChatThreadEvents: cachedChatListEvents(5312, snapshot),
  };
}

function browserSession(
  overrides: Partial<BrowserSession> = {},
): BrowserSession {
  return {
    threadId: THREAD_ID,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${THREAD_ID}`,
    liveUrl: "https://viewer.example/live?token=private",
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    screen: { width: 1440, height: 900, resizable: true },
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function mockBrowserSession(session: BrowserSession | null): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return session
      ? respond(200, { browser: session })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Browser not found" },
        });
  });
}

function getButton(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function recordHeartbeatFailures(): unknown[] {
  const failures: unknown[] = [];
  const consoleError = vi.spyOn(console, "error");
  const unexpected = consoleError.getMockImplementation();
  if (!unexpected) {
    throw new Error("Expected the shared console error guard");
  }
  consoleError.mockImplementation((...args: unknown[]) => {
    if (args[0] === "[E][BrowserHeartbeat]") {
      failures.push(args[2]);
      return;
    }
    unexpected(...args);
  });
  return failures;
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

async function openViewerSizingMenu(): Promise<HTMLElement> {
  click(screen.getByLabelText("Browser settings"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Window size"));
  return screen.findByRole("menu", { name: "Window size" });
}

async function setupInteractiveViewer(): Promise<void> {
  const activeSession = browserSession();
  const cdpUrl = "wss://cdp.browser-use.com/test";
  mockBrowserSession(activeSession);
  mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, {
      browser: activeSession,
      cdpUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: activeSession });
  });

  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
  });

  await expect(
    screen.findByRole("region", { name: "Remote browser viewer" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByDisplayValue("https://example.com")).toBeEnabled();
  });
  expect(screen.getByLabelText("New tab")).toBeInTheDocument();
}

async function setupInteractiveViewerSizingMenu(): Promise<HTMLElement> {
  await setupInteractiveViewer();
  const sizingMenu = await openViewerSizingMenu();
  expect(menuRadio(sizingMenu, "Follow panel")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  return sizingMenu;
}

async function selectViewerSizingOption(
  sizingMenu: HTMLElement,
  label: string,
): Promise<HTMLElement> {
  const option = menuRadio(sizingMenu, label);
  expect(option).not.toHaveAttribute("aria-disabled", "true");
  click(option);
  await waitFor(() => {
    expect(sizingMenu).not.toBeInTheDocument();
  });
  const updatedMenu = await openViewerSizingMenu();
  expect(menuRadio(updatedMenu, label)).toHaveAttribute("aria-checked", "true");
  return updatedMenu;
}

test("An accessible conversation without a browser can start one", async () => {
  mockBrowserSession(null);

  await setupPage({ context, path: `/browsers/${THREAD_ID}` });

  await expect(screen.findByText("Browser not live")).resolves.toBeVisible();
  expect(getButton("Start browser")).toBeEnabled();
  expect(screen.queryByText("Browser not found")).toBeNull();
});

test("The interactive Okou viewer lets the owner change automatic sizing", async () => {
  const sizingMenu = await setupInteractiveViewerSizingMenu();
  expect(menuRadio(sizingMenu, "Off")).toHaveAttribute("aria-checked", "false");
  await selectViewerSizingOption(sizingMenu, "Off");
});

test("The Okou viewer shows its host blank page only while the blank tab is selected", async () => {
  const activeSession = browserSession();
  const cdpUrl = "wss://cdp.browser-use.com/blank-page";
  mockBrowserSession(activeSession);
  mockBrowserCdp(context, cdpUrl, {
    streaming: true,
    targets: [
      { targetId: "blank-page", title: "about:blank", url: "about:blank" },
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
      },
    ],
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, {
      browser: activeSession,
      cdpUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: activeSession });
  });

  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });

  const viewer = await screen.findByRole("region", {
    name: "Remote browser viewer",
  });
  await within(viewer).findByText("Nothing open yet");
  expect(
    within(viewer).getByText(
      "Okou opens pages here as it works. Enter a URL above to browse yourself.",
    ),
  ).toBeInTheDocument();
  expect(within(viewer).getByPlaceholderText("Enter a URL")).toBeEnabled();
  const blankTab = within(viewer).getByLabelText("New tab", {
    selector: '[role="tab"]',
  });
  expect(blankTab).toHaveAttribute("aria-selected", "true");

  click(within(viewer).getByLabelText("Example", { selector: '[role="tab"]' }));
  await within(viewer).findByDisplayValue("https://example.com");
  expect(within(viewer).queryByText("Nothing open yet")).toBeNull();

  click(blankTab);
  await within(viewer).findByText("Nothing open yet");
  expect(blankTab).toHaveAttribute("aria-selected", "true");
});

test("The Okou viewer starts with WebP and lets the owner change capture settings", async () => {
  await setupInteractiveViewer();
  click(screen.getByLabelText("Browser settings"));
  const menu = await screen.findByRole("menu");
  expect(
    within(menu).getByRole("spinbutton", { name: "Image quality" }),
  ).toBeEnabled();
  click(within(menu).getByText("Image format"));
  const formats = await screen.findByRole("menu", { name: "Image format" });
  expect(menuRadio(formats, "WebP")).toHaveAttribute("aria-checked", "true");
  click(menuRadio(formats, "JPEG"));
  await waitFor(() => {
    expect(formats).not.toBeInTheDocument();
  });
  click(screen.getByLabelText("Browser settings"));
  click(within(await screen.findByRole("menu")).getByText("Image format"));
  const updated = await screen.findByRole("menu", { name: "Image format" });
  expect(menuRadio(updated, "JPEG")).toHaveAttribute("aria-checked", "true");
});

test("The browser viewer keeps one-time sizing after automatic sizing is disabled", async () => {
  const sizingMenu = await setupInteractiveViewerSizingMenu();
  const disabledSizingMenu = await selectViewerSizingOption(sizingMenu, "Off");
  expect(menuRadio(disabledSizingMenu, "On connection")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await selectViewerSizingOption(disabledSizingMenu, "On connection");
});

test("The browser viewer resumes continuous sizing after one-time sizing", async () => {
  const sizingMenu = await setupInteractiveViewerSizingMenu();
  const oneTimeSizingMenu = await selectViewerSizingOption(
    sizingMenu,
    "On connection",
  );
  expect(menuRadio(oneTimeSizingMenu, "Follow panel")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await selectViewerSizingOption(oneTimeSizingMenu, "Follow panel");
});

test("A reclaimed connection shows an unavailable state", async () => {
  mockBrowserSession(browserSession({ liveUrl: null }));
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(409, {
      error: { code: "BROWSER_NOT_LIVE", message: "Browser is no longer live" },
    });
  });
  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
  });
  await expect(
    screen.findByText("Browser view unavailable"),
  ).resolves.toBeInTheDocument();
});

test.each(["url", "instance", "window"] as const)(
  "A replacement browser %s detaches the previous viewer while its connection loads",
  async (identity) => {
    let currentSession = browserSession(
      identity !== "url"
        ? {
            liveUrl: null,
            window: { instanceId: INSTANCE_ID, primaryWindowId: 0 },
          }
        : {},
    );
    let replacing = false;
    const connectionStarted = context.mocks.deferred<void>();
    const releaseConnection = context.mocks.deferred<void>();
    const cdpUrl = "wss://cdp.browser-use.com/original";
    mockBrowserCdp(context, cdpUrl);
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser: currentSession });
    });
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: currentSession });
    });
    context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
      if (!replacing) {
        return respond(200, {
          browser: currentSession,
          cdpUrl,
          extension: TEST_BROWSER_EXTENSION,
        });
      }
      connectionStarted.resolve();
      await releaseConnection.promise;
      return respond(409, {
        error: {
          code: "BROWSER_NOT_LIVE",
          message: "Browser is no longer live",
        },
      });
    });
    await setupPage({
      context,
      path: `/browsers/${THREAD_ID}`,
    });
    await expect(
      screen.findByDisplayValue("https://example.com"),
    ).resolves.toBeEnabled();
    currentSession = browserSession(
      identity === "url"
        ? { liveUrl: "https://viewer.example/live?token=replacement" }
        : {
            liveUrl: null,
            window: {
              instanceId:
                identity === "instance"
                  ? "33333333-3333-4333-8333-333333333333"
                  : INSTANCE_ID,
              primaryWindowId: identity === "window" ? 1 : 0,
            },
          },
    );
    replacing = true;
    act(() => {
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: THREAD_ID,
      });
    });
    await connectionStarted.promise;
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Remote browser viewer" }),
      ).not.toBeInTheDocument();
    });
    releaseConnection.resolve();
    await expect(
      screen.findByText("Browser view unavailable"),
    ).resolves.toBeInTheDocument();
  },
);

test("Revealing a replacement viewer synchronizes the display measured while it was concealed", async () => {
  let canvasBox = new DOMRect(0, 0, 900, 600);
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (!(this instanceof HTMLCanvasElement)) {
        return original.call(this);
      }
      // A hidden ancestor removes the canvas box, as browser layout does.
      return this.closest("[hidden]") ? new DOMRect(0, 0, 0, 0) : canvasBox;
    },
  );
  let currentSession = browserSession();
  let replacing = false;
  const connectionStarted = context.mocks.deferred<void>();
  const releaseConnection = context.mocks.deferred<void>();
  const cdpUrl = "wss://cdp.browser-use.com/original";
  const browser = mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: currentSession });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: currentSession });
  });
  context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
    if (replacing) {
      connectionStarted.resolve();
      await releaseConnection.promise;
    }
    return respond(200, {
      browser: currentSession,
      cdpUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
  });
  act(() => {
    browser.frame("AAAA");
  });

  currentSession = browserSession({
    liveUrl: "https://viewer.example/live?token=replacement",
  });
  replacing = true;
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", {
      threadId: THREAD_ID,
    });
  });
  await connectionStarted.promise;
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Remote browser viewer" }),
    ).not.toBeInTheDocument();
  });
  // The window changes while the viewer is concealed, so it measures no box.
  canvasBox = new DOMRect(0, 0, 720, 480);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  releaseConnection.resolve();

  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 720, height: 480 });
  });
});

test.each(["cdp", "runtime"] as const)(
  "A null-URL viewer replaces its %s connection without reusing old input authority",
  async (identity) => {
    const session = browserSession({
      liveUrl: null,
      window: { instanceId: INSTANCE_ID, primaryWindowId: 0 },
    });
    let connection: BrowserViewerConnection = {
      browser: session,
      cdpUrl: "wss://cdp.browser-use.com/original-native",
      extension: { ...TEST_BROWSER_EXTENSION },
    };
    const original = mockBrowserCdp(context, connection.cdpUrl);
    mockBrowserSession(session);
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: session });
    });
    context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
      return respond(200, connection);
    });
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    const pendingInput = original.holdNext("Input.insertText");
    const oldInput = screen.getByLabelText("Remote browser input");
    await userEvent.click(oldInput);
    fireEvent.input(oldInput, {
      target: { value: "old" },
      inputType: "insertText",
    });
    await pendingInput.received;

    connection = {
      browser: session,
      cdpUrl:
        identity === "cdp"
          ? "wss://cdp.browser-use.com/replacement-native"
          : connection.cdpUrl,
      extension: {
        ...TEST_BROWSER_EXTENSION,
        runtimeId:
          identity === "runtime"
            ? "ponmlkjihgfedcbaponmlkjihgfedcba"
            : TEST_BROWSER_EXTENSION.runtimeId,
      },
    };
    const replacement = mockBrowserCdp(context, connection.cdpUrl, {
      extensionRuntimeId: connection.extension.runtimeId,
      targets: [
        {
          targetId: "replacement-page",
          title: "Replacement",
          url: "https://replacement.example.com",
          windowId: 0,
        },
      ],
    });
    act(() => {
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: THREAD_ID,
      });
    });
    await screen.findByDisplayValue("https://replacement.example.com");
    await expectStreamingViewer();
    await pendingInput.release();
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    fireEvent.input(input, {
      target: { value: "fresh" },
      inputType: "insertText",
    });
    await waitFor(() => {
      expect(
        replacement.input.filter((request) => {
          return request.method === "Input.insertText";
        }),
      ).toStrictEqual([
        {
          method: "Input.insertText",
          sessionId: "replacement-page-session",
          params: { text: "fresh" },
        },
      ]);
    });
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://replacement.example.com",
    );
  },
);

test.each([
  { windowId: undefined, liveUrl: "https://viewer.example/live" },
  { windowId: 0, liveUrl: "https://viewer.example/live" },
  { windowId: undefined, liveUrl: null },
  { windowId: 0, liveUrl: null },
])(
  "Revalidating window $windowId with provider URL $liveUrl revokes old input and resumes the native browser",
  async ({ windowId, liveUrl }) => {
    const session = browserSession({
      liveUrl,
      ...(windowId === undefined
        ? {}
        : { window: { instanceId: INSTANCE_ID, primaryWindowId: windowId } }),
    });
    const cdpUrl = "wss://cdp.browser-use.com/revalidated";
    const browser = mockBrowserCdp(context, cdpUrl);
    const connectionStarted = context.mocks.deferred<void>();
    const releaseConnection = context.mocks.deferred<void>();
    let requests = 0;
    mockBrowserSession(session);
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: session });
    });
    context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
      requests += 1;
      if (requests > 1) {
        if (!connectionStarted.settled()) {
          connectionStarted.resolve();
        }
        await releaseConnection.promise;
      }
      return respond(200, {
        browser: session,
        cdpUrl,
        extension: { ...TEST_BROWSER_EXTENSION },
      });
    });
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    act(() => {
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: THREAD_ID,
      });
    });
    await connectionStarted.promise;
    await waitFor(() => {
      expect(input).toBeDisabled();
    });
    fireEvent.input(input, {
      target: { value: "stale" },
      data: "stale",
      inputType: "insertText",
    });
    expect(browser.input).not.toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "stale" },
      }),
    );
    releaseConnection.resolve();
    await expectStreamingViewer();
    const currentInput = screen.getByLabelText("Remote browser input");
    await userEvent.click(currentInput);
    fireEvent.input(currentInput, {
      target: { value: "fresh" },
      data: "fresh",
      inputType: "insertText",
    });
    await waitFor(() => {
      expect(browser.input).toContainEqual({
        method: "Input.insertText",
        sessionId: browser.pageSession("example-page"),
        params: { text: "fresh" },
      });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

test("An inaccessible conversation has no browser page", async () => {
  mockBrowserSession(null);
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Conversation not found" },
    });
  });

  await setupPage({ context, path: `/browsers/${THREAD_ID}` });

  await expect(screen.findByText("Browser not found")).resolves.toBeVisible();
  expect(screen.queryByText("Start browser")).toBeNull();
});

test.each([
  {
    name: "a measured mobile display",
    width: 390,
    height: 600,
    dpr: 3,
    initialDisplay: { width: 390, height: 600, dpr: 3 },
  },
  {
    name: "an empty display",
    width: 0,
    height: 0,
    dpr: 1,
    initialDisplay: undefined,
  },
])(
  "A user can restart a reclaimed browser with $name",
  async ({ width, height, dpr, initialDisplay }) => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this instanceof HTMLCanvasElement
          ? new DOMRect(0, 0, width, height)
          : original.call(this);
      },
    );
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(dpr);
    const activeSession = browserSession();
    const cdpUrl = "wss://cdp.browser-use.com/restarted";
    mockBrowserCdp(context, cdpUrl);
    context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
      return respond(200, {
        browser: activeSession,
        cdpUrl,
        extension: TEST_BROWSER_EXTENSION,
      });
    });
    let startCount = 0;
    mockBrowserSession(
      browserSession({
        status: "suspended",
        liveUrl: null,
        screen: undefined,
        idleExpiresAt: null,
        suspendedAt: "2026-09-01T10:10:00.000Z",
        suspensionReason: "idle",
      }),
    );
    let requestDisplay: unknown;
    context.mocks.api(browserContract.open, ({ params, body, respond }) => {
      requestDisplay = body.initialDisplay;
      if (params.threadId === THREAD_ID) {
        startCount += 1;
      }
      return respond(200, { browser: activeSession });
    });
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: activeSession });
    });

    await setupPage({ context, path: `/browsers/${THREAD_ID}` });

    await expect(screen.findByText("Browser not live")).resolves.toBeVisible();
    expect(screen.getByLabelText("Browser settings")).toBeDisabled();
    click(getButton("Start browser"));

    await expect(
      screen.findByDisplayValue("https://example.com"),
    ).resolves.toBeEnabled();
    expect(startCount).toBe(1);
    expect(requestDisplay).toStrictEqual(initialDisplay);
    expect(screen.queryByText("Browser not live")).toBeNull();
  },
);

async function expectStreamingViewer(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

function mockSharedViewer(liveUrl: string | null = null) {
  const session = browserSession({
    liveUrl,
    window: { instanceId: INSTANCE_ID, primaryWindowId: 0 },
  });
  const cdpUrl = "wss://cdp.browser-use.com/shared-viewer";
  const browser = mockBrowserCdp(context, cdpUrl, {
    streaming: true,
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
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, {
      browser: session,
      cdpUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  return { session, cdpUrl, browser };
}

test.each(["session", "connection"] as const)(
  "An authorization denial from the %s keeps the panel with a distinct placeholder",
  async (source) => {
    const { session } = mockSharedViewer();
    mockBrowserSession(session);
    if (source === "session") {
      context.mocks.api(browserContract.get, ({ respond }) => {
        return respond(403, {
          error: {
            code: "BROWSER_AUTHORIZATION_REQUIRED",
            message: AUTHORIZATION_REQUIRED,
          },
        });
      });
    } else {
      context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
        return respond(403, {
          error: {
            code: "BROWSER_AUTHORIZATION_REQUIRED",
            message: AUTHORIZATION_REQUIRED,
          },
        });
      });
    }
    const hold = context.mocks.deferred<void>();
    context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
      await hold.promise;
      return respond(200, { browser: session });
    });
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expect(
      screen.findByText(AUTHORIZATION_REQUIRED),
    ).resolves.toBeInTheDocument();
    expect(
      document.querySelector("[data-browser-session-panel]"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Remote browser input"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Browser not live")).not.toBeInTheDocument();
    expect(screen.queryByText("Start browser")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "This browser does not belong to this chat or has been removed.",
      ),
    ).not.toBeInTheDocument();
  },
);

test("A granted initial snapshot revalidates an earlier authorization denial", async () => {
  const snapshot = context.mocks.deferred<void>();
  installChatListStream(context, {
    caseId: 5314,
    snapshot: [
      chatListThread(1, "Browser authorization", {
        id: THREAD_ID,
        cloudBrowserEnabled: true,
      }),
    ],
    remoteGate: snapshot.promise,
  });
  const { session } = mockSharedViewer();
  let granted = false;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return granted
      ? respond(200, { browser: session })
      : respond(403, {
          error: {
            code: "BROWSER_AUTHORIZATION_REQUIRED",
            message: AUTHORIZATION_REQUIRED,
          },
        });
  });
  const hold = context.mocks.deferred<void>();
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    await hold.promise;
    return respond(200, { browser: session });
  });
  const page = await startPage({ context, path: `/browsers/${THREAD_ID}` });
  await page.content;
  await screen.findByText(AUTHORIZATION_REQUIRED);
  granted = true;
  snapshot.resolve();
  await page.ready;
  await expectStreamingViewer();
  expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
});

test("A replacement snapshot revalidates a renewed grant with unchanged cached authorization", async () => {
  const thread = chatListThread(1, "Browser snapshot grant", {
    id: THREAD_ID,
    cloudBrowserEnabled: true,
  });
  installChatListStream(context, { caseId: 5315, snapshot: [thread] });
  let revision = 1;
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: [thread],
        latestEventId: chatListEvent(
          5315,
          revision,
          "computer_use_host_updated",
          THREAD_ID,
        ).id,
        latestSeqId: revision,
      }),
    );
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return (query.sinceSeqId ?? 0) < revision
      ? respond(410, {
          error: {
            code: "CHAT_THREAD_EVENTS_EXPIRED",
            message: "Chat thread events cursor has expired",
          },
        })
      : respond(200, { events: [], hasMore: false });
  });
  const { session } = mockSharedViewer();
  let allowed = true;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return allowed
      ? respond(200, { browser: session })
      : respond(403, {
          error: {
            code: "BROWSER_AUTHORIZATION_REQUIRED",
            message: AUTHORIZATION_REQUIRED,
          },
        });
  });
  const deny = context.mocks.deferred<void>();
  const hold = context.mocks.deferred<void>();
  let first = true;
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (first) {
      first = false;
      await deny.promise;
      allowed = false;
      return respond(403, {
        error: {
          code: "BROWSER_AUTHORIZATION_REQUIRED",
          message: AUTHORIZATION_REQUIRED,
        },
      });
    }
    await hold.promise;
    return respond(200, { browser: session });
  });
  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    cachedChatThreadEvents: cachedChatListEvents(5315, [thread]),
  });
  await expectStreamingViewer();
  deny.resolve();
  await screen.findByText(AUTHORIZATION_REQUIRED);
  allowed = true;
  revision = 2;
  context.mocks.ably.trigger("threadListChanged");
  await expectStreamingViewer();
  expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
});

test("A denied renewal revokes a healthy viewer without waiting for native disconnection", async () => {
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  const deny = context.mocks.deferred<void>();
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    await deny.promise;
    return respond(403, {
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: AUTHORIZATION_REQUIRED,
      },
    });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  const input = screen.getByLabelText("Remote browser input");
  deny.resolve();
  await expect(
    screen.findByText(AUTHORIZATION_REQUIRED),
  ).resolves.toBeInTheDocument();
  expect(input).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Live browser view")).not.toBeInTheDocument();
  expect(screen.queryByText("Browser not live")).not.toBeInTheDocument();
});

test("Losing authorization while starting replaces the stopped state with the authorization placeholder", async () => {
  mockBrowserSession(
    browserSession({
      status: "suspended",
      liveUrl: null,
      idleExpiresAt: null,
      suspendedAt: "2026-09-01T10:10:00.000Z",
      suspensionReason: "idle",
    }),
  );
  context.mocks.api(browserContract.open, ({ respond }) => {
    return respond(403, {
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: "Browser authorization was revoked",
      },
    });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await screen.findByText("Browser not live");
  click(getButton("Start browser"));
  await screen.findByText(AUTHORIZATION_REQUIRED);
  expect(screen.queryByText("Start browser")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Browser authorization was revoked"),
  ).not.toBeInTheDocument();
});

test("A renewed grant can start a stopped Browser while an older start is pending", async () => {
  const { authorize, cachedChatThreadEvents } = mockChatAuthorization(true);
  const { session } = mockSharedViewer();
  let currentSession = browserSession({
    status: "suspended",
    liveUrl: null,
    idleExpiresAt: null,
    suspendedAt: "2026-09-01T10:10:00.000Z",
    suspensionReason: "idle",
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: currentSession });
  });
  const oldStart = context.mocks.deferred<void>();
  const oldStartStarted = context.mocks.deferred<void>();
  let initial = true;
  context.mocks.api(browserContract.open, async ({ respond }) => {
    if (initial) {
      initial = false;
      oldStartStarted.resolve();
      await oldStart.promise;
    }
    currentSession = session;
    return respond(200, { browser: session });
  });
  const hold = context.mocks.deferred<void>();
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    await hold.promise;
    return respond(200, { browser: session });
  });
  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    cachedChatThreadEvents,
  });
  await screen.findByText("Browser not live");
  click(getButton("Start browser"));
  await oldStartStarted.promise;
  authorize(false);
  authorize(true);
  await waitFor(() => {
    expect(getButton("Start browser")).toBeEnabled();
  });
  click(getButton("Start browser"));
  await expectStreamingViewer();
});

test("An unrelated permission failure remains an observable error", async () => {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Access denied for another reason" },
    });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await screen.findByText("Access denied for another reason");
  expect(screen.getByText("Browser unavailable")).toBeInTheDocument();
  expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
});

test.each(["active", "suspended"] as const)(
  "Restoring chat authorization revalidates an existing %s Browser",
  async (status) => {
    const { authorize, cachedChatThreadEvents } = mockChatAuthorization(false);
    const { session } = mockSharedViewer();
    const currentSession =
      status === "active"
        ? session
        : browserSession({
            status: "suspended",
            liveUrl: null,
            idleExpiresAt: null,
            suspendedAt: "2026-09-01T10:10:00.000Z",
            suspensionReason: "idle",
          });
    let enabled = false;
    context.mocks.api(browserContract.get, ({ respond }) => {
      return enabled
        ? respond(200, { browser: currentSession })
        : respond(403, {
            error: {
              code: "BROWSER_AUTHORIZATION_REQUIRED",
              message: AUTHORIZATION_REQUIRED,
            },
          });
    });
    const hold = context.mocks.deferred<void>();
    context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
      await hold.promise;
      return respond(200, { browser: session });
    });
    await setupPage({
      context,
      path: `/browsers/${THREAD_ID}`,
      cachedChatThreadEvents,
    });
    await screen.findByText(AUTHORIZATION_REQUIRED);
    enabled = true;
    authorize(true);
    if (status === "active") {
      await expectStreamingViewer();
    } else {
      await screen.findByText("Browser not live");
    }
    expect(screen.queryByText("Start browser") !== null).toBe(
      status === "suspended",
    );
    expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
    enabled = false;
    authorize(false);
    await screen.findByText(AUTHORIZATION_REQUIRED);
    expect(
      screen.queryByLabelText("Remote browser input"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Browser not live")).not.toBeInTheDocument();
  },
);

test("A denied renewal from a previous reload cannot revoke the current same-window viewer", async () => {
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  const first = context.mocks.deferred<void>();
  const deny = context.mocks.deferred<void>();
  const renewed = context.mocks.deferred<void>();
  const hold = context.mocks.deferred<void>();
  let initial = true;
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (initial) {
      initial = false;
      first.resolve();
      await deny.promise;
      return respond(403, {
        error: {
          code: "BROWSER_AUTHORIZATION_REQUIRED",
          message: AUTHORIZATION_REQUIRED,
        },
      });
    }
    renewed.resolve();
    await hold.promise;
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  await first.promise;
  context.mocks.ably.trigger("browserSessionChanged", { threadId: THREAD_ID });
  await expectStreamingViewer();
  deny.resolve();
  await renewed.promise;
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
});

test("A renewed grant starts renewal without waiting for an older pending lease", async () => {
  const { authorize, cachedChatThreadEvents } = mockChatAuthorization(true);
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  const oldLease = context.mocks.deferred<void>();
  const oldLeaseStarted = context.mocks.deferred<void>();
  let initial = true;
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (initial) {
      initial = false;
      oldLeaseStarted.resolve();
      await oldLease.promise;
      return respond(200, { browser: session });
    }
    return respond(403, {
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: AUTHORIZATION_REQUIRED,
      },
    });
  });
  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    cachedChatThreadEvents,
  });
  await expectStreamingViewer();
  await oldLeaseStarted.promise;
  authorize(false);
  authorize(true);
  await screen.findByText(AUTHORIZATION_REQUIRED);
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();
  expect(
    document.querySelector("[data-browser-session-panel]"),
  ).toBeInTheDocument();
});

test("A renewed grant revalidates a healthy viewer and ignores a previous grant's denied renewal", async () => {
  const { authorize, cachedChatThreadEvents } = mockChatAuthorization(true);
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  const deny = context.mocks.deferred<void>();
  const leaseRequested = context.mocks.deferred<void>();
  const hold = context.mocks.deferred<void>();
  const revalidate = context.mocks.deferred<void>();
  const connectionRequested = context.mocks.deferred<void>();
  let initial = true;
  context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
    if (initial) {
      initial = false;
    } else {
      connectionRequested.resolve();
      await revalidate.promise;
    }
    return respond(200, {
      browser: session,
      cdpUrl: "wss://cdp.browser-use.com/shared-viewer",
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  let initialLease = true;
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (initialLease) {
      initialLease = false;
      leaseRequested.resolve();
      await deny.promise;
      return respond(403, {
        error: {
          code: "BROWSER_AUTHORIZATION_REQUIRED",
          message: AUTHORIZATION_REQUIRED,
        },
      });
    }
    await hold.promise;
    return respond(200, { browser: session });
  });
  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    cachedChatThreadEvents,
  });
  await expectStreamingViewer();
  await leaseRequested.promise;
  authorize(false);
  authorize(true);
  await connectionRequested.promise;
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  deny.resolve();
  revalidate.resolve();
  await expectStreamingViewer();
  expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
});

test("A batched disable and re-enable clears a denied lease even when cached authorization was true", async () => {
  const { authorize, cachedChatThreadEvents } = mockChatAuthorization(true);
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  const deny = context.mocks.deferred<void>();
  const hold = context.mocks.deferred<void>();
  let denied = false;
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (!denied) {
      denied = true;
      await deny.promise;
      return respond(403, {
        error: {
          code: "BROWSER_AUTHORIZATION_REQUIRED",
          message: AUTHORIZATION_REQUIRED,
        },
      });
    }
    await hold.promise;
    return respond(200, { browser: session });
  });
  await setupPage({
    context,
    path: `/browsers/${THREAD_ID}`,
    cachedChatThreadEvents,
  });
  await expectStreamingViewer();
  deny.resolve();
  await screen.findByText(AUTHORIZATION_REQUIRED);
  authorize(false);
  authorize(true);
  await expectStreamingViewer();
  expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
});

test("Confirmed expiry after a failed renewal displays the stopped state", async () => {
  const failures = recordHeartbeatFailures();
  const { session } = mockSharedViewer();
  let currentSession = session;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: currentSession });
  });
  const fail = context.mocks.deferred<void>();
  const expire = context.mocks.deferred<void>();
  let initial = true;
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (initial) {
      initial = false;
      await fail.promise;
      return respond(503, {
        error: { code: "UNAVAILABLE", message: "Temporary outage" },
      });
    }
    await expire.promise;
    return respond(409, {
      error: { code: "BROWSER_NOT_LIVE", message: "Browser expired" },
    });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  fail.resolve();
  await waitFor(() => {
    return expect(failures).toHaveLength(1);
  });
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  currentSession = browserSession({
    status: "suspended",
    liveUrl: null,
    idleExpiresAt: null,
    suspendedAt: "2026-09-01T10:10:00.000Z",
    suspensionReason: "idle",
  });
  expire.resolve();
  await screen.findByText("Browser not live");
  expect(getButton("Start browser")).toBeEnabled();
  expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
});

test.each([
  502,
  503,
  "network",
  "gateway",
  "gateway-500",
  "gateway-504",
] as const)(
  "A mounted panel renews after a transient %s lease failure and remains usable",
  async (failure) => {
    const failures = recordHeartbeatFailures();
    const { session, browser } = mockSharedViewer();
    mockBrowserSession(session);
    const first = context.mocks.deferred<void>();
    const fail = context.mocks.deferred<void>();
    const recovered = context.mocks.deferred<void>();
    const renew = context.mocks.deferred<void>();
    const following = context.mocks.deferred<void>();
    const hold = context.mocks.deferred<void>();
    let failed = false;
    let repeated = false;
    context.mocks.api(
      browserContract.leaseByThread,
      async ({ params, body, respond }) => {
        expect(params.threadId).toBe(THREAD_ID);
        expect(body).toStrictEqual({});
        if (typeof failure === "number" && !failed) {
          failed = true;
          first.resolve();
          await fail.promise;
          return respond(failure, {
            error: {
              code: "BROWSER_USE_SHARED_OPERATION_FAILED",
              message: "Managed Browser operation could not be confirmed",
            },
          });
        }
        if (failure === 503 && !repeated) {
          repeated = true;
          return respond(503, {
            error: {
              code: "BROWSER_USE_SHARED_OPERATION_FAILED",
              message: "Managed Browser operation still cannot be confirmed",
            },
          });
        }
        if (!recovered.settled()) {
          recovered.resolve();
          await renew.promise;
        } else {
          following.resolve();
          await hold.promise;
        }
        return respond(200, { browser: session });
      },
    );
    const gatewayStatus =
      failure === "gateway-500" ? 500 : failure === "gateway-504" ? 504 : 502;
    if (
      failure === "network" ||
      failure === "gateway" ||
      failure === "gateway-500" ||
      failure === "gateway-504"
    ) {
      // Transport and gateway failures do not have an application error body.
      context.mocks.http.post(
        `*/api/chat-threads/${THREAD_ID}/browser/lease`,
        async ({ signal }) => {
          if (failed) {
            return;
          }
          failed = true;
          first.resolve();
          await fail.promise;
          signal.throwIfAborted();
          return failure === "network"
            ? HttpResponse.error()
            : HttpResponse.html("<html><body>Bad Gateway</body></html>", {
                status: gatewayStatus,
              });
        },
      );
    }
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    await first.promise;
    fail.resolve();
    if (
      failure === 502 ||
      failure === "gateway-500" ||
      failure === "gateway-504"
    ) {
      act(() => {
        browser.disconnect({ code: 1006, reason: "temporary connection loss" });
      });
      await screen.findByText("Browser disconnected");
      click(getButton("Reconnect"));
      await expectStreamingViewer();
    }
    await recovered.promise;
    await userEvent.click(screen.getByLabelText("Address"));
    renew.resolve();
    await following.promise;
    expect(failures).toStrictEqual([
      {
        threadId: THREAD_ID,
        status:
          typeof failure === "number" || failure === "network"
            ? failure
            : gatewayStatus,
      },
    ]);
    await userEvent.keyboard("{End}x");
    expect(screen.getByLabelText("Address")).toHaveFocus();
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://example.comx",
    );
    await expectStreamingViewer();
  },
);

test.each([404, 409] as const)(
  "An expired browser pauses after transient recovery receives %s",
  async (status) => {
    const failures = recordHeartbeatFailures();
    const { session } = mockSharedViewer();
    let currentSession = session;
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser: currentSession });
    });
    const entered = context.mocks.deferred<void>();
    const fail = context.mocks.deferred<void>();
    let failed = false;
    context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
      if (!failed) {
        failed = true;
        entered.resolve();
        await fail.promise;
        return respond(503, {
          error: {
            code: "BROWSER_USE_CAPACITY",
            message: "Provider unavailable",
          },
        });
      }
      currentSession = browserSession({
        status: "suspended",
        liveUrl: null,
        idleExpiresAt: null,
        suspendedAt: "2026-09-01T10:10:00.000Z",
        suspensionReason: "idle",
      });
      return respond(status, {
        error: { code: "BROWSER_NOT_FOUND", message: "Browser expired" },
      });
    });
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    await entered.promise;
    fail.resolve();
    await screen.findByText("Browser not live");
    expect(failures).toHaveLength(1);
    expect(getButton("Start browser")).toBeEnabled();
  },
);

test.each(["https://viewer.example/live", null])(
  "Shared panels with provider liveUrl=%s keep their own chat alive and operate only its native window",
  async (liveUrl) => {
    const { session } = mockSharedViewer(liveUrl);
    mockBrowserSession(session);
    const first = context.mocks.deferred<void>();
    const following = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const requests: { threadId: string; body: unknown }[] = [];
    context.mocks.api(
      browserContract.leaseByThread,
      async ({ params, body, respond }) => {
        requests.push({ threadId: params.threadId, body });
        if (requests.length === 1) {
          first.resolve();
        } else {
          if (!following.settled()) {
            following.resolve();
          }
          await release.promise;
        }
        return respond(200, { browser: session });
      },
    );
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    expect(
      queryAllByRoleFast("tab").map((tab) => {
        return tab.getAttribute("aria-label");
      }),
    ).toStrictEqual(["Example"]);
    await first.promise;
    await following.promise;
    expect(requests).toStrictEqual([
      { threadId: THREAD_ID, body: {} },
      { threadId: THREAD_ID, body: {} },
    ]);
    await fill(screen.getByLabelText("Address"), "next.example/path");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveValue(
        "http://next.example/path",
      );
    });
    await expectStreamingViewer();
  },
);

test("Legacy viewers retain unscoped viewing and their mounted heartbeat", async () => {
  const { cdpUrl } = mockSharedViewer();
  const session = browserSession();
  mockBrowserSession(session);
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, {
      browser: session,
      cdpUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  const entered = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    browserContract.leaseByThread,
    async ({ params, body, respond }) => {
      expect(params.threadId).toBe(THREAD_ID);
      expect(body).toStrictEqual({});
      if (!entered.settled()) {
        entered.resolve();
      }
      await release.promise;
      return respond(200, { browser: session });
    },
  );
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  await entered.promise;
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Example", "Other chat"]);
});

test("A mounted heartbeat keeps address editing usable after renewal", async () => {
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  let connectionAvailable = true;
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return connectionAvailable
      ? respond(200, {
          browser: session,
          cdpUrl: "wss://cdp.browser-use.com/shared-viewer",
          extension: TEST_BROWSER_EXTENSION,
        })
      : respond(409, {
          error: {
            code: "BROWSER_NOT_LIVE",
            message: "Connection lookup temporarily unavailable",
          },
        });
  });
  const entered = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const finished = context.mocks.deferred<void>();
  const holdNext = context.mocks.deferred<void>();
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (entered.settled()) {
      await holdNext.promise;
    } else {
      entered.resolve();
      await release.promise;
      connectionAvailable = false;
      finished.resolve();
    }
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  await entered.promise;
  await userEvent.click(screen.getByLabelText("Address"));
  release.resolve();
  await finished.promise;
  await userEvent.keyboard("{End}x");
  expect(screen.getByLabelText("Address")).toHaveFocus();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.comx");
});

test.each([200, 404, 409] as const)(
  "A heartbeat response %s after reopening reloads its window and keeps renewing",
  async (status) => {
    const { session, cdpUrl } = mockSharedViewer();
    let currentSession = session;
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser: currentSession });
    });
    context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
      return respond(200, {
        browser: currentSession,
        cdpUrl,
        extension: TEST_BROWSER_EXTENSION,
      });
    });
    const entered = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const next = context.mocks.deferred<void>();
    const holdNext = context.mocks.deferred<void>();
    context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
      if (!entered.settled()) {
        entered.resolve();
        await release.promise;
        if (status !== 200) {
          return respond(status, {
            error: {
              code: status === 404 ? "BROWSER_NOT_FOUND" : "BROWSER_RECLAIMING",
              message: "The old window is unavailable",
            },
          });
        }
      } else {
        if (!next.settled()) {
          next.resolve();
        }
        await holdNext.promise;
      }
      return respond(200, { browser: currentSession });
    });
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    await entered.promise;
    currentSession = browserSession({
      liveUrl: session.liveUrl,
      window: { instanceId: INSTANCE_ID, primaryWindowId: 1 },
    });
    release.resolve();
    await waitFor(() => {
      expect(
        queryAllByRoleFast("tab").map((tab) => {
          return tab.getAttribute("aria-label");
        }),
      ).toStrictEqual(["Other chat"]);
    });
    await expectStreamingViewer();
    await next.promise;
  },
);

test.each(["legacy", "instance", "window"] as const)(
  "A late %s heartbeat after transient recovery preserves the replacement window and continues renewal",
  async (previous) => {
    const failures = recordHeartbeatFailures();
    const { session, cdpUrl } = mockSharedViewer();
    const initialSession = previous === "legacy" ? browserSession() : session;
    let currentSession = initialSession;
    let replacing = false;
    const connectionStarted = context.mocks.deferred<void>();
    const releaseConnection = context.mocks.deferred<void>();
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser: currentSession });
    });
    context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
      if (replacing) {
        connectionStarted.resolve();
        await releaseConnection.promise;
      }
      return respond(200, {
        browser: currentSession,
        cdpUrl,
        extension: TEST_BROWSER_EXTENSION,
      });
    });
    const entered = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const next = context.mocks.deferred<void>();
    const holdNext = context.mocks.deferred<void>();
    let failed = false;
    context.mocks.api(
      browserContract.leaseByThread,
      async ({ params, body, respond }) => {
        expect(params.threadId).toBe(THREAD_ID);
        expect(body).toStrictEqual({});
        if (!failed) {
          failed = true;
          return respond(502, {
            error: {
              code: "BROWSER_USE_SHARED_OPERATION_FAILED",
              message: "Managed Browser operation could not be confirmed",
            },
          });
        }
        if (!entered.settled()) {
          entered.resolve();
          await release.promise;
          return respond(200, {
            browser: {
              ...initialSession,
              liveUrl: previous === "legacy" ? null : initialSession.liveUrl,
            },
          });
        }
        if (!next.settled()) {
          next.resolve();
        }
        await holdNext.promise;
        return respond(200, { browser: currentSession });
      },
    );
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    await entered.promise;
    currentSession = browserSession({
      liveUrl:
        previous === "legacy"
          ? "https://viewer.example/live?token=shared-replacement"
          : initialSession.liveUrl,
      window: {
        instanceId:
          previous === "instance"
            ? "33333333-3333-4333-8333-333333333333"
            : INSTANCE_ID,
        primaryWindowId: previous === "window" ? 1 : 0,
      },
    });
    replacing = true;
    act(() => {
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: THREAD_ID,
      });
    });
    await connectionStarted.promise;
    await waitFor(() => {
      // Keep native DOM ownership until the actual CDP identity is confirmed,
      // but never expose the previous browser or admit input while pending.
      expect(
        screen.queryByRole("region", { name: "Remote browser viewer" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    });
    releaseConnection.resolve();
    await expectStreamingViewer();
    release.resolve();
    await next.promise;
    expect(failures).toHaveLength(1);
    await userEvent.click(screen.getByLabelText("Address"));
    await userEvent.keyboard("{End}x");
    expect(screen.getByLabelText("Address")).toHaveFocus();
    expect(screen.getByLabelText("Address")).toHaveValue(
      previous === "window"
        ? "https://other.example.comx"
        : "https://example.comx",
    );
  },
);

test("Navigating after transient recovery cancels the old heartbeat and renews only the new chat", async () => {
  const failures = recordHeartbeatFailures();
  const { session, cdpUrl } = mockSharedViewer();
  const nextThreadId = "44444444-4444-4444-8444-444444444444";
  function sessionForThread(threadId: string): BrowserSession {
    return {
      ...session,
      threadId,
      window: {
        instanceId: INSTANCE_ID,
        primaryWindowId: threadId === THREAD_ID ? 0 : 1,
      },
    };
  }
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    return respond(200, { browser: sessionForThread(params.threadId) });
  });
  context.mocks.api(browserContract.viewerConnection, ({ params, respond }) => {
    return respond(200, {
      browser: sessionForThread(params.threadId),
      cdpUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  const first = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  const next = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const requestedThreads: string[] = [];
  let failed = false;
  context.mocks.api(
    browserContract.leaseByThread,
    async ({ params, body, request, respond }) => {
      expect(body).toStrictEqual({});
      if (!failed) {
        failed = true;
        return respond(503, {
          error: {
            code: "BROWSER_USE_CAPACITY",
            message: "Provider unavailable",
          },
        });
      }
      requestedThreads.push(params.threadId);
      if (params.threadId === THREAD_ID) {
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
          },
          { once: true },
        );
        first.resolve();
      } else {
        next.resolve();
      }
      await release.promise;
      return respond(200, { browser: session });
    },
  );
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  await first.promise;
  act(() => {
    window.history.pushState(null, "", `/browsers/${nextThreadId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await cancelled.promise;
  await next.promise;
  expect(failures).toHaveLength(1);
  expect(requestedThreads).toStrictEqual([THREAD_ID, nextThreadId]);
  await expectStreamingViewer();
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Other chat"]);
});
