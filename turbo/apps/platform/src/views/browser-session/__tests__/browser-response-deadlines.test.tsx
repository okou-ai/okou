import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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
import { mockMonotonicNow, mockNow } from "../../../lib/time.ts";
import { initSentry } from "../../../lib/sentry.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const nextThreadId = "44444444-4444-4444-8444-444444444444";
const endpoint = "wss://browser.example/deadlines?token=private-token";

function mockViewer(autoOpen = true) {
  let time = Date.parse("2026-09-01T10:00:00.000Z");
  let elapsed = 0;
  mockNow(() => {
    return time;
  }, context.signal);
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  const startupErrors = recordBrowserStartupErrors();
  const sentry = context.mocks.sentry();
  initSentry();
  const browser = mockBrowserCdp(context, endpoint, {
    autoOpen,
    targets: [
      {
        targetId: "example-page",
        title: "Original",
        url: "https://original.example.com",
        windowId: 101,
      },
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
  let windowId = 101;
  function session(id = threadId): BrowserSession {
    return {
      threadId: id,
      name: "booking",
      status: "active",
      viewerUrl: `https://viewer.example/browsers/${id}`,
      liveUrl: null,
      screenshotUrl: null,
      proxyCountryCode: null,
      timeoutMinutes: 10,
      idleExpiresAt: new Date(time + 600_000).toISOString(),
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      window: {
        instanceId: "22222222-2222-4222-8222-222222222222",
        primaryWindowId: id === nextThreadId ? 202 : windowId,
      },
    };
  }
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    return respond(200, { browser: session(params.threadId) });
  });
  context.mocks.api(browserContract.viewerConnection, ({ params, respond }) => {
    return respond(200, {
      browser: session(params.threadId),
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    return respond(200, { browser: session(params.threadId) });
  });
  return {
    browser,
    session,
    sentry,
    startupErrors,
    advance(ms: number) {
      act(() => {
        time += ms;
        elapsed += ms;
      });
    },
    adjustWallClock(ms: number) {
      act(() => {
        time += ms;
      });
    },
    replaceBinding() {
      windowId = 202;
    },
  };
}

async function expectReady(url = "https://original.example.com") {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue(url);
  });
}

function reconnect() {
  const button = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Reconnect";
  });
  if (!button) {
    throw new Error("Expected actionable reconnect");
  }
  click(button);
}

async function insertText(text: string) {
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, { target: { value: text }, inputType: "insertText" });
}

test("Acknowledged startup without a first frame reaches a bounded failure and ignores late pixels", async () => {
  const viewer = mockViewer();
  const image = viewer.browser.holdFrames("example-page-session");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await act(async () => {
    await image.received;
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  viewer.advance(31_000);
  await screen.findByText("Browser view unavailable");
  reconnect();
  await expectReady();
  act(() => {
    image.release();
  });
  await insertText("after first-frame timeout");
  await waitFor(() => {
    expect(viewer.browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "after first-frame timeout" },
      }),
    );
  });
});

test("A held descriptor expires and its late response cannot replace recovered authority", async () => {
  const viewer = mockViewer();
  const held = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  let requests = 0;
  context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
    requests++;
    const browser = viewer.session();
    if (requests === 1) {
      requested.resolve();
      await held.promise;
    }
    return respond(200, {
      browser,
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Connecting to browser…");
  await requested.promise;
  viewer.advance(61_000);
  await screen.findByText("Browser view unavailable");
  expect(viewer.browser.connections()).toBe(0);
  viewer.replaceBinding();
  reconnect();
  await expectReady("https://replacement.example.com");
  act(() => {
    held.resolve();
  });
  await insertText("after descriptor timeout");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "after descriptor timeout" },
      sessionId: viewer.browser.pageSession("replacement"),
    });
  });
  expect(viewer.browser.connections()).toBe(1);
  expect(
    screen.queryByLabelText("Original", { selector: '[role="tab"]' }),
  ).toBeNull();
});

test("A whole startup budget bounds several individually timely setup phases", async () => {
  const viewer = mockViewer();
  const attachment = viewer.browser.holdNext("Target.attachToBrowserTarget");
  const hello = viewer.browser.holdNextNative("hello");
  const proof = viewer.browser.holdNextNative("getWindow");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await attachment.received;
  viewer.advance(21_000);
  await attachment.release();
  await hello.received;
  viewer.advance(21_000);
  await hello.release();
  await proof.received;
  viewer.advance(19_000);
  await screen.findByText("Browser view unavailable");
  reconnect();
  await expectReady();
  await proof.release();
  expect(viewer.startupErrors).toHaveLength(1);
});

test.each(["ready", "timeout"] as const)(
  "A same-binding refresh during native setup observes %s startup",
  async (outcome) => {
    const viewer = mockViewer();
    const refreshed = context.mocks.deferred<void>();
    let requests = 0;
    context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
      if (++requests === 2) {
        refreshed.resolve();
      }
      return respond(200, {
        browser: viewer.session(),
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      });
    });
    const attachment = viewer.browser.holdNext("Target.attachToBrowserTarget");
    const hello = viewer.browser.holdNextNative("hello");
    const proof = viewer.browser.holdNextNative("getWindow");
    await setupPage({ context, path: `/browsers/${threadId}` });
    await attachment.received;
    await act(async () => {
      context.mocks.ably.trigger("browserSessionChanged", { threadId });
      await refreshed.promise;
    });
    viewer.advance(21_000);
    await attachment.release();
    await hello.received;
    viewer.advance(21_000);
    await hello.release();
    await proof.received;
    if (outcome === "timeout") {
      viewer.advance(19_000);
      await screen.findByText("Browser view unavailable");
      reconnect();
    } else {
      await proof.release();
    }
    await expectReady();
    if (outcome === "timeout") {
      await proof.release();
    }
    viewer.advance(61_000);
    await insertText("after startup revalidation");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "after startup revalidation" },
      });
    });
    expect(viewer.browser.connections()).toBe(outcome === "timeout" ? 2 : 1);
  },
);

test.each(["shared", "split"] as const)(
  "Reconnect stays pending through native proof on a healthy %s wire and then waits for paint",
  async (mode) => {
    const viewer = mockViewer();
    const { browser } = viewer;
    await setupPage({ context, path: `/browsers/${threadId}` });
    await expectReady();
    if (mode === "split") {
      await separateImages(browser);
    }
    const connections = browser.connections();
    browser.failNext(
      "Runtime.evaluate",
      "Native window temporarily unavailable",
    );
    act(() => {
      browser.nativeEvent("tab-attached", browser.targets[0]);
    });
    await screen.findByText("Browser view unavailable");
    const proof = browser.holdNextNative("getWindow");
    const image = browser.holdTargetFrames("example-page");
    reconnect();
    await proof.received;
    await waitFor(() => {
      expect(
        screen.getByText("Reconnect", { selector: "button" }),
      ).toBeDisabled();
    });
    await proof.release();
    await image.received;
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      image.release();
    });
    await expectReady();
    expect(browser.connections()).toBe(connections);
  },
);

test("A rejected recovery descriptor settles the operation and permits another recovery", async () => {
  const viewer = mockViewer();
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await screen.findByText("Browser disconnected");
  let reject = true;
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    if (reject) {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
      });
    }
    return respond(200, {
      browser: viewer.session(),
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  reconnect();
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(screen.getByText("Reconnect", { selector: "button" })).toBeEnabled();
  });
  reject = false;
  reconnect();
  await expectReady();
});

test.each(["same binding", "replacement window", "empty window"] as const)(
  "A failed reconnect does not leave an error on a recovered %s",
  async (recovered) => {
    const viewer = mockViewer();
    await setupPage({ context, path: `/browsers/${threadId}` });
    await expectReady();
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await screen.findByText("Browser disconnected");
    let reject = true;
    context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
      return reject
        ? respond(500, {
            error: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
          })
        : respond(200, {
            browser: viewer.session(),
            cdpUrl: endpoint,
            extension: TEST_BROWSER_EXTENSION,
          });
    });
    reconnect();
    const failure =
      "The browser action could not be completed. Check the browser before trying again.";
    await screen.findByText(failure);
    reject = false;
    if (recovered === "replacement window") {
      viewer.replaceBinding();
    } else if (recovered === "empty window") {
      viewer.browser.targets.splice(0, 1);
    }
    act(() => {
      context.mocks.ably.trigger("browserSessionChanged", { threadId });
    });
    if (recovered === "empty window") {
      await screen.findByText("No tabs open");
    } else {
      await expectReady(
        recovered === "replacement window"
          ? "https://replacement.example.com"
          : "https://original.example.com",
      );
    }
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeEnabled();
    expect(screen.queryByText(failure)).not.toBeInTheDocument();
  },
);

test("A verified empty window completes recovery without waiting for pixels", async () => {
  const viewer = mockViewer();
  viewer.browser.targets.splice(0, 1);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("No tabs open");
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await screen.findByText("Browser disconnected");
  reconnect();
  await screen.findByText("No tabs open");
  viewer.advance(61_000);
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await expectReady("");
  expect(viewer.startupErrors).toHaveLength(0);
});

test("An accepted static page has no inactivity deadline", async () => {
  const viewer = mockViewer();
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  viewer.advance(61_000);
  await insertText("static page");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "static page" },
    });
  });
  await expectReady();
  expect(viewer.browser.connections()).toBe(1);
  expect(viewer.startupErrors).toHaveLength(0);
});

test("Changing chat cancels held recovery paint and its deadline cannot retire the next window", async () => {
  const viewer = mockViewer();
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await screen.findByText("Browser disconnected");
  const image = viewer.browser.holdTargetFrames("example-page");
  reconnect();
  await image.received;
  act(() => {
    window.history.pushState(null, "", `/browsers/${nextThreadId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expectReady("https://replacement.example.com");
  viewer.advance(61_000);
  act(() => {
    image.release();
  });
  await insertText("next chat");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "next chat" },
      sessionId: viewer.browser.pageSession("replacement"),
    });
  });
  expect(viewer.startupErrors).toHaveLength(0);
});

test.each(["shared", "split"] as const)(
  "A %s recovery with acknowledged capture but no paint settles as a retryable failure",
  async (mode) => {
    const viewer = mockViewer();
    await setupPage({ context, path: `/browsers/${threadId}` });
    await expectReady();
    if (mode === "split") {
      await separateImages(viewer.browser);
    }
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false }, 0);
    });
    await screen.findByText("Browser disconnected");
    const image = viewer.browser.holdTargetFrames("example-page");
    reconnect();
    await act(async () => {
      await image.received;
    });
    viewer.adjustWallClock(-3_600_000);
    viewer.advance(31_000);
    await screen.findByText("Browser view unavailable");
    await waitFor(() => {
      expect(
        screen.getByText("Reconnect", { selector: "button" }),
      ).toBeEnabled();
    });
    act(() => {
      image.release();
    });
    reconnect();
    await expectReady();
  },
);

test("Selecting a ready tab cancels the old first-frame deadline without failing startup", async () => {
  const viewer = mockViewer();
  viewer.browser.targets[1]!.windowId = 101;
  const image = viewer.browser.holdTargetFrames("example-page");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await image.received;
  click(screen.getByLabelText("Replacement", { selector: '[role="tab"]' }));
  await expectReady("https://replacement.example.com");
  viewer.advance(61_000);
  act(() => {
    image.release();
  });
  await insertText("selected tab");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "selected tab" },
      sessionId: viewer.browser.pageSession("replacement"),
    });
  });
  expect(viewer.startupErrors).toHaveLength(0);
});

test("A changed binding supersedes held recovery paint without inheriting its failure", async () => {
  const viewer = mockViewer();
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await screen.findByText("Browser disconnected");
  const image = viewer.browser.holdTargetFrames("example-page");
  reconnect();
  await image.received;
  viewer.replaceBinding();
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await expectReady("https://replacement.example.com");
  viewer.advance(61_000);
  act(() => {
    image.release();
  });
  await insertText("new binding");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "new binding" },
      sessionId: viewer.browser.pageSession("replacement"),
    });
  });
  expect(viewer.startupErrors).toHaveLength(0);
});

test("Changing connection mode cancels a pending recovery so a later failure can reconnect", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  browser.failNext("Runtime.evaluate", "Native window temporarily unavailable");
  act(() => {
    browser.nativeEvent("tab-attached", browser.targets[0]);
  });
  await screen.findByText("Browser view unavailable");
  const proof = browser.holdNextNative("getWindow");
  reconnect();
  await proof.received;
  await separateImages(browser);
  browser.failNext("Runtime.evaluate", "Native window temporarily unavailable");
  act(() => {
    browser.nativeEvent("tab-attached", browser.targets[0]);
  });
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(screen.getByText("Reconnect", { selector: "button" })).toBeEnabled();
  });
  reconnect();
  await expectReady();
  await proof.release();
  await insertText("after mode replacement");
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "after mode replacement" },
      sessionId: browser.pageSession("example-page"),
    });
  });
});

test("A socket that never opens reaches explicit recovery without reloading the page", async () => {
  const viewer = mockViewer(false);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Connecting to browser…");
  await waitFor(() => {
    expect(viewer.browser.connections()).toBe(1);
  });
  viewer.advance(31_000);
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(viewer.startupErrors).toHaveLength(1);
  });
  reconnect();
  await waitFor(() => {
    expect(viewer.browser.connections()).toBe(2);
  });
  act(() => {
    viewer.browser.openConnection();
  });
  await expectReady();
});

test.each(["attachment", "native hello", "inventory"] as const)(
  "An unanswered %s reaches explicit recovery without reloading the page",
  async (phase) => {
    const viewer = mockViewer();
    const { browser } = viewer;
    const receipt =
      phase === "attachment"
        ? browser.holdNext("Target.attachToBrowserTarget")
        : phase === "native hello"
          ? browser.holdNextNative("hello")
          : browser.holdNext("Target.getTargets");
    await setupPage({ context, path: `/browsers/${threadId}` });
    await receipt.received;
    viewer.advance(31_000);
    await screen.findByText("Browser view unavailable");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    await waitFor(() => {
      expect(viewer.startupErrors).toHaveLength(1);
    });
    reconnect();
    await expectReady();
    await receipt.release();
    // A fresh scoped action completes after delivery of the original-wire reply.
    click(screen.getByLabelText("New tab", { selector: "button" }));
    await waitFor(() => {
      expect(browser.targets).toContainEqual(
        expect.objectContaining({ targetId: "created-1", windowId: 101 }),
      );
    });
    expect(viewer.startupErrors).toHaveLength(1);
  },
);

test("A native read deadline permits queued revalidation without replacing the healthy wire", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const viewer = mockViewer();
  const { browser, session } = viewer;
  const renewed = context.mocks.deferred<void>();
  let observeRenewal = false;
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    if (observeRenewal && !renewed.settled()) {
      renewed.resolve();
    }
    return respond(200, { browser: session() });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const proof = browser.holdNextNative("getWindow");
  act(() => {
    browser.nativeEvent("tab-attached", browser.targets[0]);
  });
  await proof.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  observeRenewal = true;
  await renewed.promise;
  act(() => {
    browser.nativeEvent("tab-detached", browser.targets[0]);
    visibility.changeTo("hidden");
    visibility.changeTo("visible");
  });
  viewer.advance(31_000);
  await expectReady();
  expect(browser.connections()).toBe(1);
  await act(async () => {
    await proof.release();
  });
  await insertText("fresh");
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "fresh" },
        sessionId: browser.pageSession("example-page"),
      }),
    );
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://original.example.com",
  );
  expect(
    screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
  ).toBeNull();
});

async function separateImages(browser: ReturnType<typeof mockBrowserCdp>) {
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  click(await screen.findByText("Separate image connection"));
  await waitFor(() => {
    expect(browser.connections()).toBe(3);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

test.each(["shared", "split"] as const)(
  "A history timeout stays local on a %s connection and ignores its late reply",
  async (mode) => {
    const viewer = mockViewer();
    const { browser } = viewer;
    await setupPage({ context, path: `/browsers/${threadId}` });
    await expectReady();
    if (mode === "split") {
      await separateImages(browser);
    }
    const connections = browser.connections();
    const history = browser.holdNext("Page.getNavigationHistory");
    act(() => {
      browser.event(
        "Page.loadEventFired",
        { timestamp: 2 },
        browser.pageSession("example-page"),
      );
    });
    await history.received;
    viewer.advance(31_000);
    await screen.findByRole("alert");
    await expectReady();
    await act(async () => {
      await history.release();
    });
    await insertText("after read timeout");
    await waitFor(() => {
      expect(browser.input).toContainEqual(
        expect.objectContaining({
          method: "Input.insertText",
          params: { text: "after read timeout" },
        }),
      );
    });
    expect(browser.connections()).toBe(connections);
    expect(screen.queryByText("Browser disconnected")).toBeNull();
  },
);

test.each([
  ["shared", false],
  ["shared", true],
  ["split", false],
  ["split", true],
] as const)(
  "A failed scope read on %s permits explicit recovery (binding replaced=%s)",
  async (mode, replaced) => {
    const viewer = mockViewer();
    const { browser } = viewer;
    await setupPage({ context, path: `/browsers/${threadId}` });
    await expectReady();
    if (mode === "split") {
      await separateImages(browser);
    }
    const connections = browser.connections();
    const proof = browser.holdNextNative("getWindow");
    act(() => {
      browser.nativeEvent("tab-attached", browser.targets[0]);
    });
    await proof.received;
    viewer.advance(31_000);
    await screen.findByText("Browser view unavailable");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
    expect(browser.connections()).toBe(connections);
    if (replaced) {
      viewer.replaceBinding();
    }
    reconnect();
    await expectReady(
      replaced
        ? "https://replacement.example.com"
        : "https://original.example.com",
    );
    expect(browser.connections()).toBe(
      replaced ? connections + (mode === "split" ? 2 : 1) : connections,
    );
    await act(async () => {
      await proof.release();
    });
    await insertText("fresh scope");
    await waitFor(() => {
      expect(browser.input).toContainEqual(
        expect.objectContaining({
          method: "Input.insertText",
          params: { text: "fresh scope" },
          sessionId: browser.pageSession(
            replaced ? "replacement" : "example-page",
          ),
        }),
      );
    });
    expect(
      screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
    ).toBeNull();
  },
);

test("Selecting another scoped tab revalidates a rejected native read on the healthy wire", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  browser.targets[1]!.windowId = 101;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  browser.failNext("Runtime.evaluate", "Native window temporarily unavailable");
  act(() => {
    browser.nativeEvent("tab-attached", browser.targets[0]);
  });
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(screen.getByLabelText("Replacement", { selector: '[role="tab"]' }));
  await expectReady("https://replacement.example.com");
  await insertText("after revalidation");
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "after revalidation" },
      }),
    );
  });
  expect(browser.connections()).toBe(1);
});

test.each(["opening", "native read"] as const)(
  "A wall-clock rollback cannot extend the %s deadline",
  async (phase) => {
    const viewer = mockViewer(phase !== "opening");
    const { browser } = viewer;
    const receipt =
      phase === "native read" ? browser.holdNextNative("getWindow") : null;
    await setupPage({ context, path: `/browsers/${threadId}` });
    if (receipt) {
      await receipt.received;
    }
    await waitFor(() => {
      expect(browser.connections()).toBe(1);
    });
    viewer.adjustWallClock(-3_600_000);
    viewer.advance(31_000);
    await screen.findByText("Browser view unavailable");
    reconnect();
    await waitFor(() => {
      expect(browser.connections()).toBe(2);
    });
    act(() => {
      browser.openConnection();
    });
    await expectReady();
    await receipt?.release();
  },
);

async function recoverEffect(
  viewer: ReturnType<typeof mockViewer>,
  receipt: ReturnType<ReturnType<typeof mockBrowserCdp>["holdNext"]>,
  url = "https://original.example.com",
) {
  await receipt.received;
  viewer.advance(31_000);
  await screen.findByText("Browser disconnected");
  reconnect();
  await expectReady(url);
  await act(async () => {
    await receipt.release();
  });
  // Current input succeeds on a new page session after the ambiguous old effect.
  await insertText("y");
  await waitFor(() => {
    expect(viewer.browser.input).toContainEqual({
      method: "Input.insertText",
      params: { text: "y" },
      sessionId: viewer.browser.pageSession("example-page"),
    });
  });
}

test("Uncertain input is not replayed after its response deadline", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const originalSession = browser.pageSession("example-page");
  const receipt = browser.holdNext("Input.insertText");
  await insertText("x");
  await recoverEffect(viewer, receipt);
  expect(
    browser.input.filter((input) => {
      return input.method === "Input.insertText";
    }),
  ).toStrictEqual([
    {
      method: "Input.insertText",
      params: { text: "x" },
      sessionId: originalSession,
    },
    {
      method: "Input.insertText",
      params: { text: "y" },
      sessionId: browser.pageSession("example-page"),
    },
  ]);
});

test("Uncertain navigation is not replayed after its response deadline", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const receipt = browser.holdNext("Page.navigate");
  await fill(screen.getByLabelText("Address"), "next.example");
  await userEvent.keyboard("{Enter}");
  await recoverEffect(viewer, receipt, "http://next.example/");
  expect(
    browser.requests.filter((request) => {
      return request.method === "Page.navigate";
    }),
  ).toHaveLength(1);
});

test("Uncertain creation is not replayed after its response deadline", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const receipt = browser.holdNextNative("createTab");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await recoverEffect(viewer, receipt);
  expect(
    browser.targets.filter((target) => {
      return target.targetId.startsWith("created-");
    }),
  ).toHaveLength(1);
  expect(
    screen.getByLabelText("Original", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
});

test("Navigating away cancels the original read deadline and keeps the next chat usable", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const receipt = browser.holdNextNative("getWindow");
  act(() => {
    browser.nativeEvent("tab-attached", browser.targets[0]);
  });
  await receipt.received;
  act(() => {
    window.history.pushState(null, "", `/browsers/${nextThreadId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expectReady("https://replacement.example.com");
  viewer.advance(31_000);
  await act(async () => {
    await receipt.release();
  });
  await insertText("z");
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "z" },
        sessionId: browser.pageSession("replacement"),
      }),
    );
  });
  expect(viewer.sentry.reports).toStrictEqual([]);
  expect(viewer.startupErrors).toStrictEqual([]);
});

test("A cancelled attachment keeps its original deadline without releasing the replacement session", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  browser.targets[1]!.windowId = 101;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const attachment = browser.holdNext("Target.attachToTarget");
  click(screen.getByLabelText("Replacement", { selector: '[role="tab"]' }));
  await attachment.received;
  act(() => {
    browser.event("Target.targetDestroyed", { targetId: "replacement" });
  });
  await expectReady();
  viewer.advance(31_000);
  await screen.findByText("Browser disconnected");
  reconnect();
  await expectReady();
  await act(async () => {
    await attachment.release();
  });
  await insertText("current");
  await waitFor(() => {
    expect(browser.input).toContainEqual({
      method: "Input.insertText",
      params: { text: "current" },
      sessionId: browser.pageSession("example-page"),
    });
  });
  expect(viewer.sentry.reports).toHaveLength(1);
  expect(viewer.sentry.reports[0]).toMatchObject({
    context: {
      contexts: {
        browser_connection: {
          source: "response-timeout",
          cancelled_awaiting_response: 1,
        },
      },
    },
  });
});

test("Unacknowledged input and capture cleanup stay on their original connection after timeout", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const originalSession = browser.pageSession("example-page");
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Shift" },
    });
  });
  const release = browser.holdNext("Input.dispatchKeyEvent");
  const capture = browser.holdNext("Page.stopScreencast");
  act(() => {
    browser.nativeEvent("tab-attached", browser.targets[0]);
  });
  await Promise.all([release.received, capture.received]);
  expect(input).toBeDisabled();
  viewer.advance(31_000);
  await screen.findByText("Browser disconnected");
  reconnect();
  await expectReady();
  await act(async () => {
    await release.release();
    await capture.release();
  });
  await insertText("fresh");
  await waitFor(() => {
    expect(browser.input.at(-1)).toStrictEqual({
      method: "Input.insertText",
      params: { text: "fresh" },
      sessionId: browser.pageSession("example-page"),
    });
  });
  expect(
    browser.input.filter((event) => {
      return event.method === "Input.dispatchKeyEvent";
    }),
  ).toStrictEqual([
    expect.objectContaining({
      params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
      sessionId: originalSession,
    }),
    expect.objectContaining({
      params: expect.objectContaining({ type: "keyUp", key: "Shift" }),
      sessionId: originalSession,
    }),
  ]);
});
