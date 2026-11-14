import {
  browserContract,
  type BrowserSession,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/replacement";

function session(
  instanceId: string,
  windowId: number,
): BrowserViewerConnection["browser"] {
  return {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: null,
    screenshotUrl: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    window: { instanceId, primaryWindowId: windowId },
  };
}

const oldSession = session("22222222-2222-4222-8222-222222222222", 101);
const replacementSession = session("33333333-3333-4333-8333-333333333333", 202);

function mockSessionLease(
  current: () => BrowserSession = () => {
    return oldSession;
  },
) {
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: current() });
  });
}

function mockReplacement() {
  return mockBrowserCdp(context, endpoint, {
    targets: [
      {
        targetId: "replacement",
        title: "Replacement",
        url: "https://replacement.example.com",
        windowId: 202,
      },
      {
        targetId: "sibling",
        title: "Sibling",
        url: "https://sibling.example.com",
        windowId: 303,
      },
    ],
  });
}

async function expectReplacement(browser: ReturnType<typeof mockReplacement>) {
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://replacement.example.com",
    );
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await waitFor(() => {
    expect(browser.targets).toContainEqual(
      expect.objectContaining({ targetId: "created-1", windowId: 202 }),
    );
  });
}

test("An instance replaced during acquisition uses the viewer response's native window", async () => {
  mockSessionLease(() => {
    return replacementSession;
  });
  const browser = mockReplacement();
  let requests = 0;
  context.mocks.api(browserContract.get, ({ respond }) => {
    requests += 1;
    return respond(200, {
      browser: replacementSession,
      viewer: {
        browser: replacementSession,
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReplacement(browser);
  expect(requests).toBe(1);
});

test("Explicit reconnect waits for a fresh binding before admitting a replacement window", async () => {
  mockSessionLease(() => {
    return connection.browser;
  });
  const oldEndpoint = "wss://browser.example/retired";
  const retired = mockBrowserCdp(context, oldEndpoint, {
    extensionAvailable: false,
  });
  let connection: BrowserViewerConnection = {
    browser: oldSession,
    cdpUrl: oldEndpoint,
    extension: TEST_BROWSER_EXTENSION,
  };
  let requests = 0;
  const refreshed = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ respond }) => {
    requests += 1;
    if (requests > 1) {
      refreshed.resolve();
      await release.promise;
    }
    return respond(200, { browser: connection.browser, viewer: connection });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Browser view unavailable");

  const browser = mockReplacement();
  connection = {
    browser: replacementSession,
    cdpUrl: endpoint,
    extension: TEST_BROWSER_EXTENSION,
  };
  const reconnect = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Reconnect";
  });
  if (!reconnect) {
    throw new Error("Expected explicit reconnect");
  }
  click(reconnect);
  await refreshed.promise;
  expect(retired.connections()).toBe(1);
  expect(browser.connections()).toBe(0);
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  release.resolve();
  await expectReplacement(browser);
  expect(requests).toBe(2);
});

test.each(["socket opening", "native attachment"] as const)(
  "Changing connection mode cancels pending %s before reusing the same descriptor",
  async (phase) => {
    mockSessionLease();
    const browser = mockBrowserCdp(context, endpoint, {
      autoOpen: phase !== "socket opening",
      targets: [
        {
          targetId: "example-page",
          title: "Example",
          url: "https://example.com",
          windowId: 101,
        },
      ],
    });
    const attachment =
      phase === "native attachment"
        ? browser.holdNext("Target.attachToBrowserTarget")
        : null;
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, {
        browser: oldSession,
        viewer: {
          browser: oldSession,
          cdpUrl: endpoint,
          extension: TEST_BROWSER_EXTENSION,
        },
      });
    });
    await setupPage({ context, path: `/browsers/${threadId}` });
    await screen.findByText("Connecting to browser…");
    await waitFor(() => {
      expect(browser.connections()).toBe(1);
    });
    if (attachment) {
      await attachment.received;
    }
    click(screen.getByLabelText("Browser settings"));
    const settings = await screen.findByRole("menu");
    click(within(settings).getByText("Connection mode"));
    const modes = await screen.findByRole("menu", {
      name: "Connection mode",
    });
    const split = queryAllByRoleFast("menuitemradio", modes).find((item) => {
      return item.textContent?.trim() === "Separate image connection";
    });
    if (!split) {
      throw new Error("Expected separate image connection option");
    }
    click(split);
    await waitFor(() => {
      expect(browser.connections()).toBe(3);
    });
    if (phase === "socket opening") {
      act(() => {
        browser.openConnection();
      });
    }
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(browser.targets).toHaveLength(1);
  },
);

test("A distinct confirmed replacement streams while old bridge cleanup is unacknowledged", async () => {
  const advanceRecovery = browserRecoveryClock(context.signal);
  mockSessionLease(() => {
    return connection.browser;
  });
  const oldEndpoint = "wss://browser.example/retired";
  const retired = mockBrowserCdp(context, oldEndpoint, {
    targets: [
      {
        targetId: "old-page",
        title: "Old",
        url: "https://old.example.com",
        windowId: 101,
      },
    ],
  });
  let connection: BrowserViewerConnection = {
    browser: oldSession,
    cdpUrl: oldEndpoint,
    extension: TEST_BROWSER_EXTENSION,
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: connection.browser, viewer: connection });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  retired.holdNext("Runtime.removeBinding");
  act(() => {
    retired.resetWorker();
  });
  await screen.findByText("Reconnecting…");
  const browser = mockReplacement();
  connection = {
    browser: replacementSession,
    cdpUrl: endpoint,
    extension: TEST_BROWSER_EXTENSION,
  };
  advanceRecovery(1000);
  await expectReplacement(browser);
  expect(retired.targets).toHaveLength(1);
});

test("A replacement clears a delayed old creation's blank presentation", async () => {
  const advanceRecovery = browserRecoveryClock(context.signal);
  mockSessionLease(() => {
    return connection.browser;
  });
  const oldEndpoint = "wss://browser.example/retired";
  const retired = mockBrowserCdp(context, oldEndpoint, {
    targets: [
      {
        targetId: "old-page",
        title: "Old",
        url: "https://old.example.com",
        windowId: 101,
      },
    ],
  });
  let connection: BrowserViewerConnection = {
    browser: oldSession,
    cdpUrl: oldEndpoint,
    extension: TEST_BROWSER_EXTENSION,
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: connection.browser, viewer: connection });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const created = retired.holdNextNative("createTab");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await act(async () => {
    await created.received;
  });
  expect(screen.getByText("Nothing open yet")).toBeInTheDocument();
  act(() => {
    retired.resetWorker();
  });
  await screen.findByText("Reconnecting…");
  expect(screen.queryByText("Nothing open yet")).toBeNull();
  mockReplacement();
  connection = {
    browser: replacementSession,
    cdpUrl: endpoint,
    extension: TEST_BROWSER_EXTENSION,
  };
  advanceRecovery(1000);
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://replacement.example.com",
    );
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.queryByText("Nothing open yet")).toBeNull();
  await act(async () => {
    await created.release();
  });
  expect(
    screen.getByLabelText("Replacement", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByText("Nothing open yet")).toBeNull();
});
