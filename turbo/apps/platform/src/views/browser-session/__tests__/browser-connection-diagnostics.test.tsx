import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { initSentry } from "../../../lib/sentry.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/private-session?token=private-token";

async function setupViewer(
  autoOpen: boolean,
  options: {
    readonly empty?: boolean;
    readonly configure?: (browser: ReturnType<typeof mockBrowserCdp>) => void;
  } = {},
) {
  const sentry = context.mocks.sentry();
  initSentry();
  const browser = mockBrowserCdp(context, endpoint, {
    autoOpen,
    ...(options.empty ? { targets: [] } : {}),
  });
  options.configure?.(browser);
  const session: BrowserSession = {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 0,
    },
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: session,
      viewer: {
        browser: session,
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  return { browser, sentry, session };
}

async function expectInputReady() {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

test("A bridge bootstrap failure keeps safe CDP facts in its semantic startup report", async () => {
  const { sentry } = await setupViewer(true, {
    configure: (browser) => {
      browser.failNext("Runtime.addBinding", endpoint, -32_001);
    },
  });
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(sentry.reports).toHaveLength(1);
  });
  const failure = sentry.reports[0];
  expect(failure).toMatchObject({
    type: "exception",
    error: {
      name: "CdpFault",
      kind: "extension",
      request: { method: "Runtime.addBinding", code: -32_001 },
    },
    context: {
      tags: { browser_event: "recovery-stopped", logger: "Browser" },
      contexts: {
        browser_recovery: { outcome: "terminal" },
        browser_bridge: {
          stage: "bind-events",
          reason: "cdp-protocol-failed",
          request: { method: "Runtime.addBinding", code: -32_001 },
        },
      },
    },
  });
  const diagnostic = JSON.stringify(failure, (_key, value: unknown) => {
    return value instanceof Error
      ? {
          ...value,
          message: value.message,
          stack: value.stack,
          cause: value.cause,
        }
      : value;
  });
  expect(diagnostic).not.toMatch(
    /private-|fixture-worker|native-browser-|worker-\d/,
  );
});

test("Revalidating an opening viewer retains its native startup and keeps cancellation quiet", async () => {
  const { browser, sentry, session } = await setupViewer(false);
  await waitFor(() => {
    expect(browser.connections()).toBe(1);
  });
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ respond }) => {
    requested.resolve();
    await release.promise;
    return respond(200, {
      browser: session,
      viewer: {
        browser: session,
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
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
  await expectInputReady();
  expect(browser.connections()).toBe(1);
  expect(sentry.reports).toStrictEqual([]);
});

test("A handled background lookup stays quiet while the selected page remains usable", async () => {
  const { browser, sentry } = await setupViewer(true);
  await expectInputReady();
  const lookup = browser.holdNextMembership("created-1");
  act(() => {
    browser.duplicate("example-page");
  });
  await lookup.received;
  await act(async () => {
    await lookup.releaseFailure("private-provider-message");
  });
  await fill(screen.getByLabelText("Address"), "next.example");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "http://next.example/",
    );
  });
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(sentry.reports).toHaveLength(0);
});

test.each([
  "net::ERR_ABORTED",
  "net::ERR_BLOCKED_BY_CLIENT",
  "net::ERR_BLOCKED_BY_ADMINISTRATOR",
])(
  "A native %s retains local feedback without a product exception",
  async (reason) => {
    const { browser, sentry } = await setupViewer(true);
    await expectInputReady();
    browser.rejectNextNavigation(reason);
    await fill(screen.getByLabelText("Address"), "private-page.example");
    await userEvent.keyboard("{Enter}");
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "The browser action could not be completed. Check the browser before trying again.",
    );
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toBeEnabled();
    expect(sentry.reports).toHaveLength(0);
    expect(
      browser.requests.filter((request) => {
        return request.method === "Page.navigate";
      }),
    ).toHaveLength(1);

    await fill(screen.getByLabelText("Address"), "recovered.example");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveValue(
        "http://recovered.example/",
      );
      expect(screen.getByLabelText("Address")).toBeEnabled();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sentry.reports).toHaveLength(0);
    expect(
      browser.requests.filter((request) => {
        return request.method === "Page.navigate";
      }),
    ).toHaveLength(2);
  },
);

test.each([
  {
    label: "A known native failure",
    errorText: "net::ERR_NAME_NOT_RESOLVED",
    reason: "net::ERR_NAME_NOT_RESOLVED",
  },
  {
    label: "An unknown native failure",
    errorText: "Failed at https://private-page.example/?token=private-secret",
    reason: "unknown",
  },
  {
    label: "An expected token with extra native text",
    errorText:
      "net::ERR_ABORTED https://private-page.example/?token=private-secret",
    reason: "unknown",
  },
])(
  "$label reports safe attribution and leaves the viewer usable",
  async ({ errorText, reason }) => {
    const { browser, sentry } = await setupViewer(true);
    await expectInputReady();
    browser.rejectNextNavigation(errorText);
    await fill(screen.getByLabelText("Address"), "private-page.example");
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("alert");
    await waitFor(() => {
      expect(sentry.reports).toHaveLength(1);
    });
    expect(sentry.reports[0]).toMatchObject({
      type: "exception",
      error: {
        name: "NavigationFault",
        cause: {
          name: "NativeNavigationFault",
          reason,
          request: { method: "Page.navigate" },
        },
      },
      context: {
        tags: { logger: "Promise" },
        contexts: { browser_navigation: { method: "Page.navigate", reason } },
      },
    });
    const diagnostic = JSON.stringify(
      sentry.reports,
      (_key, value: unknown) => {
        return value instanceof Error
          ? {
              ...value,
              message: value.message,
              stack: value.stack,
              cause: value.cause,
            }
          : value;
      },
    );
    expect(diagnostic).not.toContain("private-");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toBeEnabled();
    expect(
      browser.requests.filter((request) => {
        return request.method === "Page.navigate";
      }),
    ).toHaveLength(1);

    await fill(screen.getByLabelText("Address"), "recovered.example");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveValue(
        "http://recovered.example/",
      );
      expect(screen.getByLabelText("Address")).toBeEnabled();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sentry.reports).toHaveLength(1);
  },
);

test("An unhandled navigation request failure still reports without disconnecting", async () => {
  const { browser, sentry } = await setupViewer(true);
  await expectInputReady();
  browser.failNext("Page.navigate", "private-provider-message");
  await fill(screen.getByLabelText("Address"), "private-page.example");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("alert");
  await waitFor(() => {
    expect(sentry.reports).toHaveLength(1);
  });
  expect(sentry.reports[0]).toMatchObject({
    type: "exception",
    error: {
      name: "NavigationFault",
      cause: {
        name: "CdpFault",
        request: { method: "Page.navigate", code: -32_000 },
      },
    },
    context: { tags: { logger: "Promise" } },
  });
  expect(JSON.stringify(sentry.reports)).not.toContain("private-");
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
});
