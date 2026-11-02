import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  recordBrowserStartupErrors,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { initSentry } from "../../../lib/sentry.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/private-session?token=private-token";

async function setupViewer(autoOpen: boolean) {
  const sentry = context.mocks.sentry();
  initSentry();
  const browser = mockBrowserCdp(context, endpoint, { autoOpen });
  const session: BrowserSession = {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: session });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, {
      browser: session,
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  return { browser, sentry, session };
}

test("An opening failure preserves observations and supports explicit reconnect", async () => {
  const startupErrors = recordBrowserStartupErrors();
  const { browser, sentry } = await setupViewer(false);
  await screen.findByText("Connecting to browser…");
  await waitFor(() => {
    expect(browser.connections()).toBe(1);
  });
  act(() => {
    browser.failConnection();
  });
  await screen.findByText("Browser view unavailable");
  const message =
    "WebSocket error (phase=before-open, readyState=3; close details unavailable).";
  await waitFor(() => {
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({ name: "CdpFault", message }),
      }),
    );
    expect(startupErrors).toHaveLength(1);
    expect(startupErrors[0]?.message).toBe(message);
  });

  const reconnect = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Reconnect";
  });
  if (!reconnect) {
    throw new Error("Expected explicit reconnect");
  }
  click(reconnect);
  await waitFor(() => {
    expect(browser.connections()).toBe(2);
  });
  act(() => {
    browser.openConnection();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("Revalidating an opening viewer retains its native startup and keeps cancellation quiet", async () => {
  const startupErrors = recordBrowserStartupErrors();
  const { browser, sentry, session } = await setupViewer(false);
  await waitFor(() => {
    expect(browser.connections()).toBe(1);
  });
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
    requested.resolve();
    await release.promise;
    return respond(200, {
      browser: session,
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await requested.promise;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    browser.openConnection();
  });
  release.resolve();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(browser.connections()).toBe(1);
  expect(startupErrors).toHaveLength(0);
  expect(sentry.reports).toStrictEqual([]);
});

test.each(["error", "close"] as const)(
  "A native %s during navigation preserves the established connection's failure",
  async (event) => {
    const { browser, sentry } = await setupViewer(true);
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const navigation = browser.holdNext("Page.navigate");
    await fill(screen.getByLabelText("Address"), "next.example");
    await userEvent.keyboard("{Enter}");
    await navigation.received;
    act(() => {
      if (event === "error") {
        browser.failConnection();
      } else {
        browser.disconnect({ code: 1001, wasClean: true, reason: endpoint });
      }
    });
    await screen.findByText("Browser disconnected");
    const message =
      event === "error"
        ? "WebSocket error (phase=after-open, readyState=3; close details unavailable)."
        : "WebSocket closed (phase=after-open, readyState=3, code=1001, wasClean=true).";
    await waitFor(() => {
      expect(sentry.reports).toContainEqual(
        expect.objectContaining({
          type: "exception",
          error: expect.objectContaining({
            name: "NavigationFault",
            cause: expect.objectContaining({ name: "CdpFault", message }),
          }),
        }),
      );
    });
    await navigation.release();
  },
);
