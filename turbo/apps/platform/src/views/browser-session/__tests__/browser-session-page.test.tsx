import {
  browserContract,
  type BrowserSession,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";

const context = testContext();
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";

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
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
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
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
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
    screen.findByText("Browser unavailable"),
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
        return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
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
      screen.findByText("Browser unavailable"),
    ).resolves.toBeInTheDocument();
  },
);

test.each(["cdp", "runtime"] as const)(
  "A null-URL viewer replaces its %s connection without reusing old input authority",
  async (identity) => {
    const session = browserSession({
      liveUrl: null,
      window: { instanceId: INSTANCE_ID, primaryWindowId: 0 },
    });
    let connection: BrowserViewerConnection = {
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

test("A user can restart a reclaimed browser", async () => {
  const activeSession = browserSession();
  const cdpUrl = "wss://cdp.browser-use.com/restarted";
  mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
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
  context.mocks.api(browserContract.open, ({ params, respond }) => {
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
  click(getButton("Start browser"));

  await expect(
    screen.findByDisplayValue("https://example.com"),
  ).resolves.toBeEnabled();
  expect(startCount).toBe(1);
  expect(screen.queryByText("Browser not live")).toBeNull();
});

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
  mockBrowserCdp(context, cdpUrl, {
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
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
  });
  return { session, cdpUrl };
}

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
  mockSharedViewer();
  const session = browserSession();
  mockBrowserSession(session);
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
    const { session } = mockSharedViewer();
    let currentSession = session;
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser: currentSession });
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
  "A late %s heartbeat preserves the replacement window and continues renewal",
  async (previous) => {
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
      return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
    });
    const entered = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const next = context.mocks.deferred<void>();
    const holdNext = context.mocks.deferred<void>();
    context.mocks.api(
      browserContract.leaseByThread,
      async ({ params, body, respond }) => {
        expect(params.threadId).toBe(THREAD_ID);
        expect(body).toStrictEqual({});
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
      expect(
        screen.queryByLabelText("Remote browser input"),
      ).not.toBeInTheDocument();
    });
    releaseConnection.resolve();
    await expectStreamingViewer();
    release.resolve();
    await next.promise;
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

test("Navigating to another chat cancels the old heartbeat and renews only the new chat", async () => {
  const { session } = mockSharedViewer();
  const nextThreadId = "44444444-4444-4444-8444-444444444444";
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    return respond(200, {
      browser: {
        ...session,
        threadId: params.threadId,
        window: {
          instanceId: INSTANCE_ID,
          primaryWindowId: params.threadId === THREAD_ID ? 0 : 1,
        },
      },
    });
  });
  const first = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  const next = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const requestedThreads: string[] = [];
  context.mocks.api(
    browserContract.leaseByThread,
    async ({ params, body, request, respond }) => {
      expect(body).toStrictEqual({});
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
  expect(requestedThreads).toStrictEqual([THREAD_ID, nextThreadId]);
  await expectStreamingViewer();
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Other chat"]);
});
