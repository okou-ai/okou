import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

async function setupViewer(
  autoOpen: boolean,
  options: {
    readonly empty?: boolean;
    readonly scoped?: boolean;
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
    proxyCountryCode: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...(options.scoped
      ? {
          window: {
            instanceId: "22222222-2222-4222-8222-222222222222",
            primaryWindowId: 0,
          },
        }
      : {}),
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

async function expectInputReady() {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

async function useSplitTransport() {
  click(screen.getByLabelText("Browser settings"));
  const settings = await screen.findByRole("menu", {
    name: "Browser settings",
  });
  click(within(settings).getByText("Connection mode"));
  const menu = await screen.findByRole("menu", { name: "Connection mode" });
  click(within(menu).getByText("Separate image connection"));
  await expectInputReady();
}
test("A bridge bootstrap failure keeps safe CDP facts in its semantic startup report", async () => {
  const startupErrors = recordBrowserStartupErrors();
  const { sentry } = await setupViewer(true, {
    configure: (browser) => {
      browser.failNext("Runtime.addBinding", endpoint, -32_001);
    },
  });
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(startupErrors).toHaveLength(1);
  });
  const failure = startupErrors[0];
  expect(failure).toMatchObject({
    name: "CdpFault",
    kind: "extension",
    code: undefined,
    request: { method: "Runtime.addBinding", code: -32_001 },
    cause: {
      name: "BrowserBridgeError",
      diagnostics: {
        stage: "bind-events",
        reason: "cdp-protocol-failed",
        request: { method: "Runtime.addBinding", code: -32_001 },
      },
    },
  });
  await waitFor(() => {
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({ type: "exception", error: failure }),
    );
    expect(sentry.reports).toHaveLength(1);
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

test.each([
  { failure: "epoch change", reason: "epoch-changed" },
  { failure: "sequence gap", reason: "sequence-gap" },
  { failure: "worker crash", reason: "worker-crashed" },
])(
  "A bridge $failure revokes the scoped viewer without changing recovery policy",
  async ({ failure, reason }) => {
    const { browser, sentry } = await setupViewer(true, { scoped: true });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    act(() => {
      if (failure === "epoch change") {
        browser.resetWorker();
      } else if (failure === "sequence gap") {
        browser.skipNativeEvent();
        browser.nativeEvent("tab-updated");
      } else {
        const worker = browser.requests.find((request) => {
          return request.method === "Runtime.addBinding";
        });
        if (!worker?.sessionId) {
          throw new Error("Expected the observed worker session");
        }
        browser.event("Inspector.targetCrashed", {}, worker.sessionId);
      }
    });
    await screen.findByText("Browser disconnected");
    expect(sentry.reports).toHaveLength(1);
    expect(sentry.reports[0]).toMatchObject({
      type: "exception",
      error: {
        name: "CdpFault",
        kind: "extension",
        cause: {
          name: "BrowserBridgeError",
          diagnostics: { stage: "ready", reason },
        },
      },
      context: {
        tags: { browser_event: "established-disconnect", logger: "Browser" },
      },
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
    const reconnect = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Reconnect";
    });
    if (!reconnect) {
      throw new Error("Expected explicit reconnect");
    }
    click(reconnect);
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(sentry.reports).toHaveLength(1);
  },
);

test.each([
  { failure: "epoch change", reason: "epoch-changed" },
  { failure: "sequence gap", reason: "sequence-gap" },
  { failure: "worker crash", reason: "worker-crashed" },
])(
  "A $failure during hello keeps its typed cause through the startup owner",
  async ({ failure, reason }) => {
    const startupErrors = recordBrowserStartupErrors();
    let hello:
      | ReturnType<ReturnType<typeof mockBrowserCdp>["holdNextNative"]>
      | undefined;
    const { browser } = await setupViewer(true, {
      configure: (peer) => {
        hello = peer.holdNextNative("hello");
      },
    });
    if (!hello) {
      throw new Error("Expected the pending hello response");
    }
    await hello.received;
    act(() => {
      if (failure === "epoch change") {
        browser.resetWorker();
      } else if (failure === "sequence gap") {
        browser.skipNativeEvent();
        browser.nativeEvent("tab-updated");
      } else {
        const worker = browser.requests.find((request) => {
          return request.method === "Runtime.addBinding";
        });
        if (!worker?.sessionId) {
          throw new Error("Expected the observed worker session");
        }
        browser.event("Inspector.targetCrashed", {}, worker.sessionId);
      }
    });
    await hello.release();
    await screen.findByText("Browser view unavailable");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    await waitFor(() => {
      expect(startupErrors).toHaveLength(1);
    });
    expect(startupErrors[0]).toMatchObject({
      name: "CdpFault",
      kind: "extension",
      cause: {
        name: "BrowserBridgeError",
        diagnostics: { stage: "hello", reason },
      },
    });
  },
);

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
    expect(sentry.reports).toHaveLength(1);
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
  await expectInputReady();
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
  await expectInputReady();
  expect(browser.connections()).toBe(1);
  expect(startupErrors).toHaveLength(0);
  expect(sentry.reports).toStrictEqual([]);
});

test.each(["error", "close", "frames-close"] as const)(
  "A native %s during navigation reports the established failure once",
  async (event) => {
    const { browser, sentry } = await setupViewer(true);
    await expectInputReady();
    if (event === "frames-close") {
      await useSplitTransport();
    }
    const navigation = browser.holdNext("Page.navigate");
    await fill(screen.getByLabelText("Address"), "next.example");
    await userEvent.keyboard("{Enter}");
    await navigation.received;
    act(() => {
      if (event === "error") {
        browser.failConnection();
      } else {
        browser.disconnect(
          { code: 1001, wasClean: true, reason: endpoint },
          event === "frames-close" ? 1 : undefined,
        );
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
            name: "CdpFault",
            message,
          }),
          context: expect.objectContaining({
            tags: {
              browser_event: "established-disconnect",
              logger: "Browser",
            },
          }),
        }),
      );
    });
    await navigation.release();
    // Re-enable navigation on an explicit replacement: the old operation and
    // its causal wrapper have settled before counting the incident reports.
    const reconnect = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Reconnect";
    });
    if (!reconnect) {
      throw new Error("Expected explicit reconnect");
    }
    click(reconnect);
    await expectInputReady();
    expect(sentry.reports).toHaveLength(1);
    // The original navigation took effect before its reply was lost. Recovery
    // observes that document without replaying the uncertain navigation.
    expect(screen.getByLabelText("Address")).toHaveValue(
      "http://next.example/",
    );
    expect(
      browser.requests.filter((request) => {
        return request.method === "Page.navigate";
      }),
    ).toHaveLength(1);
  },
);

test.each([true, false])(
  "An idle viewer (empty=%s) reports one safe established disconnection",
  async (empty) => {
    const { browser, sentry } = await setupViewer(true, { empty });
    if (empty) {
      await screen.findByText("No tabs open");
    } else {
      await expectInputReady();
    }
    act(() => {
      browser.disconnect({ code: 1006, wasClean: false, reason: endpoint });
    });
    await screen.findByText("Browser disconnected");
    expect(sentry.reports).toHaveLength(1);
    expect(sentry.reports[0]).toMatchObject({
      type: "exception",
      error: { name: "CdpFault", kind: "connection" },
      context: {
        tags: { browser_event: "established-disconnect", logger: "Browser" },
        contexts: {
          browser_viewer: { kind: "connection", role: "control" },
          browser_connection: {
            source: "native-close",
            role: "control",
            phase: "open",
            ready_state: 3,
            code: 1006,
            was_clean: false,
            pending_requests: 0,
            cancelled_awaiting_response: 0,
          },
        },
      },
    });
    expect(JSON.stringify(sentry.reports)).not.toContain("private-");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  },
);

test("A handled background lookup stays quiet while the selected page remains usable", async () => {
  const { browser, sentry } = await setupViewer(true, { scoped: true });
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

test("Changing transport retires intentionally, then frames loss reports once", async () => {
  const { browser, sentry } = await setupViewer(true);
  await expectInputReady();
  await useSplitTransport();
  await waitFor(() => {
    expect(browser.connections()).toBe(3);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(sentry.reports).toHaveLength(0);
  act(() => {
    browser.disconnect({ code: 1001, wasClean: true }, 1);
  });
  await screen.findByText("Browser disconnected");
  // A concurrent control close belongs to the same viewer incident.
  act(() => {
    browser.disconnect({ code: 1006, wasClean: false });
  });
  expect(sentry.reports).toHaveLength(1);
  expect(sentry.reports[0]).toMatchObject({
    context: {
      contexts: {
        browser_viewer: { kind: "connection", role: "frames" },
        browser_connection: {
          source: "native-close",
          role: "frames",
          code: 1001,
        },
      },
    },
  });
});

test("Control loss during a split capture change does not report the retired frames request again", async () => {
  const { browser, sentry } = await setupViewer(true);
  await expectInputReady();
  await useSplitTransport();
  const capture = browser.holdNext("Page.stopScreencast");
  click(screen.getByLabelText("Browser settings"));
  const quality = await screen.findByRole("spinbutton", {
    name: "Image quality",
  });
  fireEvent.change(quality, { target: { value: "60" } });
  await capture.received;
  act(() => {
    browser.disconnect({ code: 1006, wasClean: false }, 0);
  });
  await screen.findByText("Browser disconnected");
  await capture.release();
  const reconnect = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Reconnect";
  });
  if (!reconnect) {
    throw new Error("Expected explicit reconnect");
  }
  click(reconnect);
  await expectInputReady();
  expect(sentry.reports).toHaveLength(1);
});
