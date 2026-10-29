import {
  browserContract,
  type BrowserSession,
  type BrowserViewerActivity,
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

test.each(["url", "instance"] as const)(
  "A replacement browser %s detaches the previous viewer while its connection loads",
  async (identity) => {
    let currentSession = browserSession(
      identity === "instance"
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
    const previousViewer = screen.getByRole("region", {
      name: "Remote browser viewer",
    });
    currentSession = browserSession(
      identity === "instance"
        ? {
            window: {
              instanceId: "33333333-3333-4333-8333-333333333333",
              primaryWindowId: 0,
            },
          }
        : {
            liveUrl: "https://viewer.example/live?token=replacement",
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
      expect(previousViewer).not.toBeInTheDocument();
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
  const socket = mockBrowserCdp(context, cdpUrl, {
    streaming: true,
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
      },
      {
        targetId: "other-chat-page",
        title: "Other chat",
        url: "https://other.example.com",
      },
    ],
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl });
  });
  return { session, socket };
}

test.each(["wheel", "paste", "copy", "click"] as const)(
  "An idle shared viewer renews only after selected-page %s input",
  async (interaction) => {
    const { session } = mockSharedViewer();
    mockBrowserSession(session);
    const evidence = context.mocks.deferred<
      BrowserViewerActivity | undefined
    >();
    const bodies: unknown[] = [];
    context.mocks.api(browserContract.leaseByThread, ({ body, respond }) => {
      bodies.push(body);
      evidence.resolve(body.viewerActivity);
      return respond(200, { browser: session });
    });
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    expect(bodies).toStrictEqual([]);
    if (interaction === "wheel") {
      fireEvent.wheel(screen.getByLabelText("Live browser view"), {
        deltaY: 20,
      });
    } else if (interaction === "click") {
      // Assistive activation can dispatch click without pointer or key events.
      fireEvent.click(screen.getByLabelText("Reload remote page"));
    } else {
      fireEvent(
        screen.getByLabelText("Remote browser input"),
        new Event(interaction, { bubbles: true, cancelable: true }),
      );
    }
    await expect(evidence.promise).resolves.toStrictEqual({
      instanceId: INSTANCE_ID,
      pageTargetId: "example-page",
    });
  },
);

test("The standalone route uses the selected other-chat page for renewal", async () => {
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  const evidence = context.mocks.deferred<BrowserViewerActivity | undefined>();
  context.mocks.api(
    browserContract.leaseByThread,
    ({ params, body, respond }) => {
      expect(params.threadId).toBe(THREAD_ID);
      evidence.resolve(body.viewerActivity);
      return respond(200, { browser: session });
    },
  );
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Other chat";
  });
  if (!tab) {
    throw new Error("Expected the other chat's page tab");
  }
  click(tab);
  await waitFor(() => {
    expect(tab).toHaveAttribute("aria-selected", "true");
  });
  await expectStreamingViewer();
  fireEvent.wheel(screen.getByLabelText("Live browser view"), { deltaY: 20 });
  await expect(evidence.promise).resolves.toStrictEqual({
    instanceId: INSTANCE_ID,
    pageTargetId: "other-chat-page",
  });
});

test.each(["another", "the same"] as const)(
  "Navigating to %s chat on the same shared instance keeps viewer activity working",
  async (destination) => {
    const { session } = mockSharedViewer();
    const nextThreadId =
      destination === "the same"
        ? THREAD_ID
        : "44444444-4444-4444-8444-444444444444";
    let navigating = false;
    let connectedThreadId: string | null = null;
    const evidence = context.mocks.deferred<
      BrowserViewerActivity | undefined
    >();
    context.mocks.api(browserContract.get, ({ params, respond }) => {
      return respond(200, {
        browser: {
          ...session,
          threadId: params.threadId,
          viewerUrl: `https://viewer.example/browsers/${params.threadId}`,
        },
      });
    });
    context.mocks.api(
      browserContract.viewerConnection,
      ({ params, respond }) => {
        if (navigating) {
          connectedThreadId = params.threadId;
        }
        return respond(200, {
          cdpUrl: "wss://cdp.browser-use.com/shared-viewer",
        });
      },
    );
    context.mocks.api(
      browserContract.leaseByThread,
      ({ params, body, respond }) => {
        expect(params.threadId).toBe(nextThreadId);
        evidence.resolve(body.viewerActivity);
        return respond(200, {
          browser: {
            ...session,
            threadId: nextThreadId,
            viewerUrl: `https://viewer.example/browsers/${nextThreadId}`,
          },
        });
      },
    );
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expectStreamingViewer();
    act(() => {
      navigating = true;
      window.history.pushState(null, "", `/browsers/${nextThreadId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => {
      expect(connectedThreadId).toBe(nextThreadId);
    });
    await expectStreamingViewer();
    fireEvent.wheel(screen.getByLabelText("Live browser view"), { deltaY: 20 });
    await expect(evidence.promise).resolves.toStrictEqual({
      instanceId: INSTANCE_ID,
      pageTargetId: "example-page",
    });
  },
);

test("Switching pages cancels queued activity and immediately leases fresh input on the new target", async () => {
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  const first = context.mocks.deferred<void>();
  const selected = context.mocks.deferred<BrowserViewerActivity | undefined>();
  context.mocks.api(browserContract.leaseByThread, ({ body, respond }) => {
    if (body.viewerActivity?.pageTargetId === "other-chat-page") {
      selected.resolve(body.viewerActivity);
    } else {
      first.resolve();
    }
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  fireEvent.wheel(screen.getByLabelText("Live browser view"), { deltaY: 20 });
  await first.promise;
  fireEvent.wheel(screen.getByLabelText("Live browser view"), { deltaY: 20 });
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Other chat";
  });
  if (!tab) {
    throw new Error("Expected the other chat's page tab");
  }
  click(tab);
  await waitFor(() => {
    expect(tab).toHaveAttribute("aria-selected", "true");
  });
  await expectStreamingViewer();
  fireEvent.wheel(screen.getByLabelText("Live browser view"), { deltaY: 20 });
  await expect(selected.promise).resolves.toStrictEqual({
    instanceId: INSTANCE_ID,
    pageTargetId: "other-chat-page",
  });
});

async function interruptSharedRenewal(
  replacement: "target" | "instance" | "unmount" | "disconnect",
): Promise<void> {
  const { session, socket } = mockSharedViewer();
  let currentSession = session;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: currentSession });
  });
  const entered = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const finished = context.mocks.deferred<void>();
  context.mocks.api(
    browserContract.leaseByThread,
    async ({ request, respond }) => {
      request.signal.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
        },
        { once: true },
      );
      entered.resolve();
      await release.promise;
      finished.resolve();
      return respond(200, {
        browser: browserSession({ status: "suspended", liveUrl: null }),
      });
    },
  );
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  fireEvent.wheel(screen.getByLabelText("Live browser view"), { deltaY: 20 });
  await entered.promise;
  if (replacement === "target") {
    const tab = queryAllByRoleFast("tab").find((candidate) => {
      return candidate.getAttribute("aria-label") === "Other chat";
    });
    if (!tab) {
      throw new Error("Expected the other chat's page tab");
    }
    click(tab);
  } else if (replacement === "disconnect") {
    act(() => {
      socket.disconnect("wss://cdp.browser-use.com/shared-viewer");
    });
  } else {
    currentSession =
      replacement === "unmount"
        ? browserSession({ status: "suspended", liveUrl: null })
        : browserSession({
            window: {
              instanceId: "33333333-3333-4333-8333-333333333333",
              primaryWindowId: 0,
            },
          });
    act(() => {
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: THREAD_ID,
      });
    });
  }
  await cancelled.promise;
  release.resolve();
  await finished.promise;
}

test.each(["target", "instance"] as const)(
  "Shared viewer %s replacement cancels an outstanding renewal",
  async (replacement) => {
    await interruptSharedRenewal(replacement);
    await expectStreamingViewer();
    expect(screen.queryByText("Browser not live")).toBeNull();
  },
);

test("Unmounting a shared viewer cancels its outstanding renewal", async () => {
  await interruptSharedRenewal("unmount");
  await expect(
    screen.findByText("Browser not live"),
  ).resolves.toBeInTheDocument();
});

test("Disconnecting a shared viewer cancels its outstanding renewal", async () => {
  await interruptSharedRenewal("disconnect");
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
});

test("A shared viewer keeps address editing usable after its first successful renewal", async () => {
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
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    entered.resolve();
    await release.promise;
    connectionAvailable = false;
    finished.resolve();
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  await userEvent.click(screen.getByLabelText("Remote page address"));
  await entered.promise;
  release.resolve();
  await finished.promise;
  await userEvent.keyboard("{End}x");
  expect(screen.getByLabelText("Remote page address")).toHaveFocus();
  expect(screen.getByLabelText("Remote page address")).toHaveValue(
    "https://example.comx",
  );
});
