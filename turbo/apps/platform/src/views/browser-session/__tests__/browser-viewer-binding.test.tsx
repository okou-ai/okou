import {
  browserContract,
  type BrowserSession,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  recordBrowserStartupErrors,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/replacement";

function session(instanceId: string, windowId: number): BrowserSession {
  return {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: null,
    screenshotUrl: null,
    proxyCountryCode: null,
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

function mockSessionReads() {
  let requests = 0;
  context.mocks.api(browserContract.get, ({ respond }) => {
    requests += 1;
    // A GET that finished before replacement must never supply native authority.
    return respond(200, { browser: oldSession });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: oldSession });
  });
  return () => {
    return requests;
  };
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
  const startupErrors = recordBrowserStartupErrors();
  mockSessionReads();
  const browser = mockReplacement();
  let requests = 0;
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    requests += 1;
    return respond(200, {
      browser: replacementSession,
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReplacement(browser);
  expect(requests).toBe(1);
  expect(startupErrors).toHaveLength(0);
});

test("Explicit reconnect waits for a fresh binding before admitting a replacement window", async () => {
  const startupErrors = recordBrowserStartupErrors();
  const sessionRequests = mockSessionReads();
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
  context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
    requests += 1;
    if (requests > 1) {
      refreshed.resolve();
      await release.promise;
    }
    return respond(200, connection);
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(startupErrors).toHaveLength(1);
  });
  const initialSessions = sessionRequests();
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
  expect(sessionRequests()).toBeGreaterThan(initialSessions);
  expect(retired.connections()).toBe(1);
  expect(browser.connections()).toBe(0);
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  release.resolve();
  await expectReplacement(browser);
  expect(requests).toBe(2);
  expect(startupErrors).toHaveLength(1);
});
