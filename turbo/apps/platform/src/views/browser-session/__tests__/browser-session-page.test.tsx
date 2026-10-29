import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockBrowserCdp } from "../../../__tests__/browser-cdp-fixture.ts";

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

async function openViewerSizingMenu(): Promise<HTMLElement> {
  click(screen.getByLabelText("Browser menu"));
  const menu = await screen.findByRole("menu", { name: "Browser menu" });
  click(within(menu).getByText("Fit to this viewer"));
  return screen.findByRole("menu", { name: "Fit to this viewer" });
}

async function setupInteractiveViewer(): Promise<void> {
  const activeSession = browserSession();
  const cdpUrl = "wss://cdp.browser-use.com/test";
  mockBrowserSession(activeSession);
  mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl });
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
  await expect(
    screen.findByDisplayValue("https://example.com"),
  ).resolves.toBeEnabled();
  expect(screen.getByLabelText("New tab")).toBeInTheDocument();
}

async function setupInteractiveViewerSizingMenu(): Promise<HTMLElement> {
  await setupInteractiveViewer();
  const sizingMenu = await openViewerSizingMenu();
  expect(within(sizingMenu).getByText("Sync continuously")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  return sizingMenu;
}

async function selectViewerSizingOption(
  sizingMenu: HTMLElement,
  label: string,
): Promise<HTMLElement> {
  const option = within(sizingMenu).getByText(label);
  expect(option).not.toHaveAttribute("aria-disabled", "true");
  click(option);
  await waitFor(() => {
    expect(sizingMenu).not.toBeInTheDocument();
  });
  const updatedMenu = await openViewerSizingMenu();
  expect(within(updatedMenu).getByText(label)).toHaveAttribute(
    "aria-checked",
    "true",
  );
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
  expect(
    within(sizingMenu).getByText("Do not sync automatically"),
  ).toHaveAttribute("aria-checked", "false");
  await selectViewerSizingOption(sizingMenu, "Do not sync automatically");
});

test("The Okou viewer starts with WebP and lets the owner change capture settings", async () => {
  await setupInteractiveViewer();
  click(screen.getByLabelText("Browser menu"));
  const menu = await screen.findByRole("menu", { name: "Browser menu" });
  click(within(menu).getByText("Capture quality"));
  const capture = await screen.findByRole("dialog", {
    name: "Capture quality",
  });
  expect(within(capture).getByRole("radio", { name: "WebP" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(within(capture).getByRole("slider")).toBeEnabled();

  click(within(capture).getByRole("radio", { name: "JPEG" }));
  await waitFor(() => {
    expect(
      within(capture).getByRole("radio", { name: "JPEG" }),
    ).toHaveAttribute("aria-checked", "true");
  });
});

test("The browser viewer keeps one-time sizing after automatic sizing is disabled", async () => {
  const sizingMenu = await setupInteractiveViewerSizingMenu();
  const disabledSizingMenu = await selectViewerSizingOption(
    sizingMenu,
    "Do not sync automatically",
  );
  expect(
    within(disabledSizingMenu).getByText("Sync once on opening"),
  ).toHaveAttribute("aria-checked", "false");
  await selectViewerSizingOption(disabledSizingMenu, "Sync once on opening");
});

test("The browser viewer resumes continuous sizing after one-time sizing", async () => {
  const sizingMenu = await setupInteractiveViewerSizingMenu();
  const oneTimeSizingMenu = await selectViewerSizingOption(
    sizingMenu,
    "Sync once on opening",
  );
  expect(
    within(oneTimeSizingMenu).getByText("Sync continuously"),
  ).toHaveAttribute("aria-checked", "false");
  await selectViewerSizingOption(oneTimeSizingMenu, "Sync continuously");
});

test("A reclaimed connection shows an unavailable state", async () => {
  mockBrowserSession(browserSession());
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
        ? { window: { instanceId: INSTANCE_ID, primaryWindowId: 0 } }
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
        return respond(200, { cdpUrl });
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
    return respond(200, { cdpUrl });
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

function mockSharedViewer() {
  const session = browserSession({
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
    return respond(200, { cdpUrl });
  });
  return { session, cdpUrl };
}

test("Shared panels keep their own chat alive without input and show only its native window", async () => {
  const { session } = mockSharedViewer();
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
});

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
      ? respond(200, { cdpUrl: "wss://cdp.browser-use.com/shared-viewer" })
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
  await userEvent.click(screen.getByLabelText("Remote page address"));
  release.resolve();
  await finished.promise;
  await userEvent.keyboard("{End}x");
  expect(screen.getByLabelText("Remote page address")).toHaveFocus();
  expect(screen.getByLabelText("Remote page address")).toHaveValue(
    "https://example.comx",
  );
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
      return respond(200, { cdpUrl });
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
    await userEvent.click(screen.getByLabelText("Remote page address"));
    await userEvent.keyboard("{End}x");
    expect(screen.getByLabelText("Remote page address")).toHaveFocus();
    expect(screen.getByLabelText("Remote page address")).toHaveValue(
      "https://example.comx",
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
