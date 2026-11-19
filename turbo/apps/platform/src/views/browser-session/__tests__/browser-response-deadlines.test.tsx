import {
  browserContract,
  type BrowserConnection,
} from "@okouai/api-contracts/contracts/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
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
  function session(id = threadId): BrowserConnection["browser"] {
    return {
      threadId: id,
      name: "booking",
      status: "active",
      viewerUrl: `https://viewer.example/browsers/${id}`,
      liveUrl: null,
      screenshotUrl: null,
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
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    return respond(200, {
      browser: session(params.threadId),
      viewer: {
        browser: session(params.threadId),
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    return respond(200, { browser: session(params.threadId) });
  });
  return {
    browser,
    session,
    sentry,
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

async function expectNewTabReady() {
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeEnabled();
  });
}

async function insertText(text: string) {
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, { target: { value: text }, inputType: "insertText" });
}

function mockCanvasViewport() {
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (!(this instanceof HTMLCanvasElement)) {
        return originalBounds.call(this);
      }
      // Model browser layout: display-none ancestors remove the canvas box;
      // visual concealment alone preserves its intersection with the viewport.
      return this.closest("[hidden]")
        ? new DOMRect(0, 0, 0, 0)
        : new DOMRect(0, 0, 900, 600);
    },
  );
  const NativeIntersectionObserver = window.IntersectionObserver;
  let changeVisibility: ((visible?: boolean) => void) | undefined;
  vi.spyOn(window, "IntersectionObserver").mockImplementation(
    class extends NativeIntersectionObserver {
      private layout: MutationObserver | null = null;

      constructor(
        private readonly onChange: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        super(onChange, options);
      }
      override observe(target: Element) {
        super.observe(target);
        this.layout?.disconnect();
        let inViewport = true;
        let previous: boolean | undefined;
        const publish = (visible?: boolean) => {
          if (visible !== undefined) {
            inViewport = visible;
          }
          const rectangle = target.getBoundingClientRect();
          const intersects = inViewport && rectangle.width > 0;
          if (intersects === previous) {
            return;
          }
          previous = intersects;
          this.onChange(
            [
              {
                target,
                isIntersecting: intersects,
                intersectionRatio: intersects ? 1 : 0,
                boundingClientRect: rectangle,
                intersectionRect: rectangle,
                rootBounds: null,
                time: 0,
              },
            ],
            this,
          );
        };
        changeVisibility = publish;
        this.layout = new MutationObserver(() => {
          publish();
        });
        this.layout.observe(document.body, {
          attributes: true,
          attributeFilter: ["hidden"],
          subtree: true,
        });
        context.signal.addEventListener(
          "abort",
          () => {
            this.disconnect();
          },
          { once: true },
        );
      }
      override unobserve(target: Element) {
        super.unobserve(target);
        this.layout?.disconnect();
        this.layout = null;
      }
      override disconnect() {
        super.disconnect();
        this.layout?.disconnect();
        this.layout = null;
      }
    },
  );
  return (visible?: boolean) => {
    const publish = changeVisibility;
    if (!publish) {
      throw new Error("Expected the mounted canvas to be observed");
    }
    act(() => {
      publish(visible);
    });
  };
}

async function concealReplacement() {
  const updateViewport = mockCanvasViewport();
  const viewer = mockViewer();
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  updateViewport();
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  let hold = true;
  context.mocks.api(browserContract.get, async ({ respond }) => {
    const browser = viewer.session();
    if (hold) {
      hold = false;
      requested.resolve();
      await response.promise;
    }
    return respond(200, {
      browser: browser,
      viewer: {
        browser,
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  viewer.replaceBinding();
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await requested.promise;
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  // Deliver the layout intersection Chrome would observe during concealment.
  updateViewport();
  return { viewer, response };
}

test.each(["initially hidden"] as readonly (
  "initially hidden" | "hidden during native setup"
)[])(
  "A viewer %s resumes through the existing native startup",
  async (phase) => {
    const visibility = context.mocks.browser.visibilityState(
      phase === "initially hidden" ? "hidden" : "visible",
    );
    const viewer = mockViewer();
    const hello =
      phase === "hidden during native setup"
        ? viewer.browser.holdNextNative("hello")
        : null;
    await setupPage({ context, path: `/browsers/${threadId}` });
    if (hello) {
      await hello.received;
      act(() => {
        visibility.changeTo("hidden");
      });
      await screen.findByText("Viewing paused");
      await hello.release();
    }
    await screen.findByText("Viewing paused");
    expect(viewer.browser.activeConnections()).toBe(hello ? 1 : 0);
    act(() => {
      visibility.changeTo("visible");
    });
    await expectReady();
    await screen.findByLabelText("Original", { selector: '[role="tab"]' });
    await insertText("after paused startup");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "after paused startup" },
      });
    });
    expect(viewer.browser.connections()).toBe(1);
  },
);

test("A viewport pause during native setup keeps its DOM-owned resume path", async () => {
  const changeVisibility = mockCanvasViewport();
  const viewer = mockViewer();
  const hello = viewer.browser.holdNextNative("hello");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await hello.received;
  changeVisibility(false);
  await screen.findByText("Viewing paused");
  await hello.release();
  viewer.advance(121_000);
  changeVisibility(true);
  await expectReady();
  await screen.findByLabelText("Original", { selector: '[role="tab"]' });
  expect(viewer.browser.connections()).toBe(1);
});

test("A concealed replacement reveals descriptor timeout and permits recovery", async () => {
  const { viewer, response } = await concealReplacement();
  viewer.advance(61_000);
  await expect(screen.findByText("Reconnecting…")).resolves.toBeVisible();
  viewer.advance(4000);
  await expectReady("https://replacement.example.com");
  response.resolve();
  await insertText("replacement after timeout");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("replacement"),
      params: { text: "replacement after timeout" },
    });
  });
});

test("A startup failure while paused retires with its native owner and can resume", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const viewer = mockViewer();
  const hello = viewer.browser.holdNextNative("hello");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await hello.received;
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  viewer.advance(31_000);
  await waitFor(() => {
    expect(viewer.browser.activeConnections()).toBe(0);
  });
  act(() => {
    visibility.changeTo("visible");
  });
  await expectReady();
  await hello.release();
  await insertText("after retired startup");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "after retired startup" },
      sessionId: viewer.browser.pageSession("example-page"),
    });
  });
  expect(viewer.browser.connections()).toBe(2);
});

test("A held descriptor expires and its late response cannot replace recovered authority", async () => {
  const viewer = mockViewer();
  const held = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  let requests = 0;
  context.mocks.api(browserContract.get, async ({ respond }) => {
    requests++;
    const browser = viewer.session();
    if (requests === 1) {
      requested.resolve();
      await held.promise;
    }
    return respond(200, {
      browser: browser,
      viewer: {
        browser,
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Connecting to browser…");
  await requested.promise;
  viewer.advance(61_000);
  await screen.findByText("Reconnecting…");
  expect(viewer.browser.connections()).toBe(0);
  viewer.replaceBinding();
  viewer.advance(4000);
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

test("A transport change shares the root startup budget without refreshing its descriptor", async () => {
  const viewer = mockViewer();
  let descriptors = 0;
  context.mocks.api(browserContract.get, ({ respond }) => {
    descriptors++;
    return respond(200, {
      browser: viewer.session(),
      viewer: {
        browser: viewer.session(),
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const attachment = viewer.browser.holdNext("Target.attachToBrowserTarget");
  const hello = viewer.browser.holdNextNative("hello");
  const proof = viewer.browser.holdNextNative("getWindow");
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  click(await screen.findByText("Separate image connection"));
  await attachment.received;
  viewer.advance(21_000);
  await attachment.release();
  await hello.received;
  viewer.advance(21_000);
  await hello.release();
  await proof.received;
  viewer.advance(19_000);
  await screen.findByText("Reconnecting…");
  expect(descriptors).toBe(1);
  viewer.advance(4000);
  await expectReady();
  await proof.release();
  expect(descriptors).toBe(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test.each(["ready"] as readonly ("ready" | "timeout")[])(
  "A same-binding refresh during native setup observes %s startup",
  async (outcome) => {
    const viewer = mockViewer();
    const refreshed = context.mocks.deferred<void>();
    let requests = 0;
    context.mocks.api(browserContract.get, ({ respond }) => {
      if (++requests === 2) {
        refreshed.resolve();
      }
      return respond(200, {
        browser: viewer.session(),
        viewer: {
          browser: viewer.session(),
          cdpUrl: endpoint,
          extension: TEST_BROWSER_EXTENSION,
        },
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
      await screen.findByText("Reconnecting…");
      viewer.advance(4000);
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

test.each(["shared"] as readonly ("shared" | "split")[])(
  "Automatic recovery stays pending through native proof on a healthy %s wire and then waits for paint",
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
    await screen.findByText("Reconnecting…");
    const proof = browser.holdNextNative("getWindow");
    const image = browser.holdTargetFrames("example-page");
    viewer.advance(4000);
    await proof.received;
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
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

test.each(["replacement window"] as readonly (
  "same binding" | "replacement window" | "empty window"
)[])(
  "A failed reconnect does not leave an error on a recovered %s",
  async (recovered) => {
    const viewer = mockViewer();
    await setupPage({ context, path: `/browsers/${threadId}` });
    await expectReady();
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await screen.findByText("Reconnecting…");
    let reject = true;
    context.mocks.api(browserContract.get, ({ respond }) => {
      return reject
        ? respond(500, {
            error: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
          })
        : respond(200, {
            browser: viewer.session(),
            viewer: {
              browser: viewer.session(),
              cdpUrl: endpoint,
              extension: TEST_BROWSER_EXTENSION,
            },
          });
    });
    viewer.advance(4000);
    const failure =
      "The browser action could not be completed. Check the browser before trying again.";
    await screen.findByText("Unavailable");
    await screen.findByText("Reconnecting…");
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    });
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
      await expectNewTabReady();
      viewer.advance(4000);
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
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await screen.findByText("Reconnecting…");
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
  await screen.findByText("Reconnecting…");
  viewer.advance(4000);
  await screen.findByText("No tabs open");
  viewer.advance(61_000);
  expect(
    screen.getByLabelText("New tab", { selector: "button" }),
  ).toBeEnabled();
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await expectReady("");
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
});

test.each([false, true])(
  "Changing chat cancels recovery (paused: %s) without retiring the next window",
  async (paused) => {
    const visibility = context.mocks.browser.visibilityState("visible");
    const viewer = mockViewer();
    await setupPage({ context, path: `/browsers/${threadId}` });
    await expectReady();
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await screen.findByText("Reconnecting…");
    const image = viewer.browser.holdTargetFrames("example-page");
    viewer.advance(4000);
    await image.received;
    if (paused) {
      act(() => {
        visibility.changeTo("hidden");
      });
      await screen.findByText("Viewing paused");
    }
    act(() => {
      window.history.pushState(null, "", `/browsers/${nextThreadId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      if (paused) {
        visibility.changeTo("visible");
      }
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
  },
);

test.each(["shared"] as readonly ("shared" | "split")[])(
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
    await screen.findByText("Reconnecting…");
    const image = viewer.browser.holdTargetFrames("example-page");
    viewer.advance(4000);
    await act(async () => {
      await image.received;
    });
    viewer.adjustWallClock(-3_600_000);
    viewer.advance(31_000);
    await screen.findByText("Reconnecting…");
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    });
    act(() => {
      image.release();
    });
    viewer.advance(4000);
    await expectReady();
  },
);

test.each(["shared"] as readonly ("shared" | "split")[])(
  "First-frame timeouts during tab selection and image retry preserve the healthy %s connection",
  async (mode) => {
    const viewer = mockViewer();
    viewer.browser.targets[1]!.windowId = 101;
    await setupPage({ context, path: `/browsers/${threadId}` });
    await expectReady();
    if (mode === "split") {
      await separateImages(viewer.browser);
    }
    await insertText("before local first-frame timeout");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "before local first-frame timeout" },
      });
    });
    const image = viewer.browser.holdTargetFrames("replacement");
    click(screen.getByLabelText("Replacement", { selector: '[role="tab"]' }));
    await act(async () => {
      await image.received;
    });
    viewer.advance(31_000);
    await screen.findByText("Reconnecting…");

    expect(
      screen.getByLabelText("Original", { selector: '[role="tab"]' }),
    ).not.toHaveAttribute("aria-disabled", "true");
    act(() => {
      image.release();
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    const retryImage = viewer.browser.holdTargetFrames("replacement");
    viewer.advance(4000);
    await act(async () => {
      await retryImage.received;
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    viewer.advance(31_000);
    await screen.findByText("Reconnecting…");

    act(() => {
      retryImage.release();
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    viewer.advance(4000);
    await expectReady("https://replacement.example.com");
    await insertText("after local first-frame timeout");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        sessionId: viewer.browser.pageSession("replacement"),
        params: { text: "after local first-frame timeout" },
      });
    });
  },
);

test("A delayed capture acknowledgement keeps its later image timeout local", async () => {
  const viewer = mockViewer();
  viewer.browser.targets[1]!.windowId = 101;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const capture = viewer.browser.holdNext("Page.startScreencast");
  const image = viewer.browser.holdTargetFrames("replacement");
  click(screen.getByLabelText("Replacement", { selector: '[role="tab"]' }));
  await act(async () => {
    await capture.received;
    await image.received;
  });
  viewer.advance(20_000);
  await act(async () => {
    await capture.release();
  });
  viewer.advance(31_000);
  await screen.findByText("Reconnecting…");

  expect(viewer.browser.connections()).toBe(1);
  act(() => {
    image.release();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  viewer.advance(4000);
  await expectReady("https://replacement.example.com");
});

test("A tab selected during timed-out capture cleanup survives the old readiness result", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const viewer = mockViewer();
  viewer.browser.targets[1]!.windowId = 101;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  await insertText("before paused selection");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "before paused selection" },
    });
  });
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  const image = viewer.browser.holdTargetFrames("example-page");
  act(() => {
    visibility.changeTo("visible");
  });
  await act(async () => {
    await image.received;
  });
  const capture = viewer.browser.holdNext("Page.stopScreencast");
  viewer.advance(31_000);
  await capture.received;
  click(screen.getByLabelText("Replacement", { selector: '[role="tab"]' }));
  await expectReady("https://replacement.example.com");
  await act(async () => {
    await capture.release();
    image.release();
  });
  await expectReady("https://replacement.example.com");
  await insertText("after old capture cleanup");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("replacement"),
      params: { text: "after old capture cleanup" },
    });
  });
});

test("A binding change cancels a pending transport operation while viewport-paused", async () => {
  const sharedConnection = () => {
    const option = queryAllByRoleFast("menuitemradio").find((item) => {
      return item.textContent?.trim() === "Shared connection";
    });
    if (!option) {
      throw new Error("Expected the shared connection option");
    }
    return option;
  };
  const changeVisibility = mockCanvasViewport();
  const viewer = mockViewer();
  await setupPage({ context, path: `/browsers/${threadId}` });
  await expectReady();
  const hello = viewer.browser.holdNextNative("hello");
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  click(await screen.findByText("Separate image connection"));
  await hello.received;
  changeVisibility(false);
  await screen.findByText("Viewing paused");
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  await waitFor(() => {
    expect(sharedConnection()).toHaveAttribute("aria-disabled", "true");
  });
  await userEvent.keyboard("{Escape}{Escape}");
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ respond }) => {
    const browser = viewer.session();
    requested.resolve();
    await response.promise;
    return respond(200, {
      browser: browser,
      viewer: {
        browser,
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  viewer.replaceBinding();
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await requested.promise;
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  response.resolve();
  await screen.findByRole("region", { name: "Remote browser viewer" });
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  await waitFor(() => {
    expect(sharedConnection()).not.toHaveAttribute("aria-disabled", "true");
  });
  await userEvent.keyboard("{Escape}{Escape}");
  changeVisibility(true);
  await expectReady("https://replacement.example.com");
  await hello.release();
  await insertText("after paused supersession");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("replacement"),
      params: { text: "after paused supersession" },
    });
  });
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
  await screen.findByText("Reconnecting…");
  const proof = browser.holdNextNative("getWindow");
  viewer.advance(4000);
  await proof.received;
  await separateImages(browser);
  browser.failNext("Runtime.evaluate", "Native window temporarily unavailable");
  act(() => {
    browser.nativeEvent("tab-attached", browser.targets[0]);
  });
  await screen.findByText("Reconnecting…");
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  viewer.advance(4000);
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

test("A socket that never opens reaches automatic recovery without reloading the page", async () => {
  const viewer = mockViewer(false);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Connecting to browser…");
  await waitFor(() => {
    expect(viewer.browser.connections()).toBe(1);
  });
  viewer.advance(31_000);
  await screen.findByText("Reconnecting…");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();

  viewer.advance(4000);
  await waitFor(() => {
    expect(viewer.browser.connections()).toBe(2);
  });
  act(() => {
    viewer.browser.openConnection();
  });
  await expectReady();
});

test("An unanswered native hello permits explicit reconnection without replaying its late reply", async () => {
  const viewer = mockViewer();
  const { browser } = viewer;
  const receipt = browser.holdNextNative("hello");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await receipt.received;
  viewer.advance(31_000);
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(screen.getByText("Reconnect", { selector: "button" }));
  await expectReady();
  await receipt.release();
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await waitFor(() => {
    expect(browser.targets).toContainEqual(
      expect.objectContaining({ targetId: "created-1", windowId: 101 }),
    );
  });
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

test.each([["shared", false]] as readonly (readonly [
  "shared" | "split",
  boolean,
])[])(
  "A failed scope read on %s permits automatic recovery (binding replaced=%s)",
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
    await screen.findByText("Reconnecting…");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
    expect(browser.connections()).toBe(connections);
    if (replaced) {
      viewer.replaceBinding();
    }
    viewer.advance(4000);
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
  await screen.findByText("Reconnecting…");
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

async function recoverEffect(
  viewer: ReturnType<typeof mockViewer>,
  receipt: ReturnType<ReturnType<typeof mockBrowserCdp>["holdNext"]>,
  url = "https://original.example.com",
) {
  await receipt.received;
  viewer.advance(31_000);
  await screen.findByText("Reconnecting…");
  viewer.advance(4000);
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
  await screen.findByText("Reconnecting…");
  viewer.advance(4000);
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
  expect(viewer.sentry.reports).toHaveLength(0);
});
