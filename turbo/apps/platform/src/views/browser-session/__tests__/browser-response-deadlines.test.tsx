import { act, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockNow } from "../../../lib/time.ts";
import { isRecord } from "../../../signals/utils.ts";
import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const original = Object.freeze({
  targetId: "original",
  title: "Original",
  url: "https://original.example.test",
  windowId: 101,
});
const replacement = Object.freeze({
  targetId: "replacement",
  title: "Replacement",
  url: "https://replacement.example.test",
  windowId: 202,
});
function viewer() {
  return arrangeNativePage(context, { targets: [original] });
}
function remoteInput() {
  return screen.getByLabelText("Remote browser input");
}
async function sendText(
  cdp: ReturnType<typeof viewer>["cdp"],
  text: string,
  target: string = original.targetId,
) {
  const field = remoteInput();
  await userEvent.click(field);
  fireEvent.input(field, {
    data: text,
    inputType: "insertText",
    target: { value: text },
  });
  await waitFor(() => {
    return expect(cdp.inputForTarget(target)).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        sessionId: cdp.pageSession(target),
        params: { text },
      }),
    );
  });
}
test("browser-response-deadlines-001 Opening a hidden viewer defers use until it becomes visible", async () => {
  const documentState = context.mocks.browser.visibilityState("hidden");
  const { cdp, openPage } = viewer();
  await openPage();
  await screen.findByText("Viewing paused");
  expect(remoteInput()).toBeDisabled();
  documentState.changeTo("visible");
  await expectStreamingAt(original.url);
  await sendText(cdp, "visible again");
  expect(cdp.connections()).toBe(1);
});
test("browser-response-deadlines-021 An idle static page still receives text in its original session", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = viewer();
  await openPage();
  await expectStreamingAt(original.url);
  const session = cdp.pageSession(original.targetId);
  advance(60_001);
  await sendText(cdp, "after a quiet minute");
  await expectStreamingAt(original.url);
  expect(cdp.pageSession(original.targetId)).toBe(session);
  expect(cdp.connections()).toBe(1);
});
test("browser-response-deadlines-020 A reconnected empty window can create a tab after a minute", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = arrangeNativePage(context, { targets: [] });
  await openPage();
  await screen.findByText("No tabs open");
  cdp.disconnect({ code: 1006 });
  await screen.findByText("Reconnecting…");
  advance(1001);
  await screen.findByText("No tabs open");
  advance(60_001);
  const create = screen.getByText("New tab", { selector: "button" });
  expect(create).toBeEnabled();
  click(create);
  await waitFor(() => {
    return expect(remoteInput()).toBeEnabled();
  });
  expect(
    screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(cdp.targets).toContainEqual(
    expect.objectContaining({ url: "about:blank", windowId: 101 }),
  );
});
test("browser-response-deadlines-036 An unopened socket expires and a fresh socket restores the displayed page", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [original],
    autoOpen: false,
  });
  await openPage();
  await waitFor(() => {
    return expect(cdp.connections()).toBe(1);
  });
  advance(29_999);
  expect(remoteInput()).toBeDisabled();
  expect(screen.queryByText("Reconnecting…")).toBeNull();
  advance(2);
  await screen.findByText("Reconnecting…");
  expect(remoteInput()).toBeDisabled();
  advance(1001);
  await waitFor(() => {
    return expect(cdp.connections()).toBe(2);
  });
  cdp.openConnection();
  await expectStreamingAt(original.url);
});
test("browser-response-deadlines-014 A successful window check waits for paint before reenabling input", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = viewer();
  await openPage();
  await expectStreamingAt(original.url);
  const fault = cdp.holdNextMembership(original.targetId);
  cdp.duplicate(original.targetId);
  await fault.received;
  await fault.releaseFailure("temporary window lookup failure");
  await screen.findByText("Reconnecting…");
  const proof = cdp.holdNextNative("getWindow");
  const paint = cdp.holdTargetFrames(original.targetId);
  advance(4000);
  await proof.received;
  expect(remoteInput()).toBeDisabled();
  await proof.release();
  await paint.received;
  expect(remoteInput()).toBeDisabled();
  paint.release();
  await expectStreamingAt(original.url);
  expect(cdp.connections()).toBe(1);
});
test("browser-response-deadlines-012 A same-window refresh joins the pending startup before its deadline", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, viewer: descriptor, openPage } = viewer();
  const refresh = context.mocks.deferred<void>();
  let awaitingRefresh = false;
  context.mocks.api(browserContract.get, ({ respond }) => {
    if (awaitingRefresh && !refresh.settled()) {
      refresh.resolve();
    }
    return respond(200, { browser: descriptor.browser, viewer: descriptor });
  });
  const attachment = cdp.holdNext("Target.attachToTarget", "okou-worker");
  const hello = cdp.holdNextNative("hello");
  const proof = cdp.holdNextNative("getWindow");
  await openPage();
  await attachment.received;
  awaitingRefresh = true;
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: descriptor.browser.threadId,
  });
  await refresh.promise;
  advance(21_000);
  await attachment.release();
  await hello.received;
  advance(21_000);
  await hello.release();
  await proof.received;
  advance(17_999);
  expect(remoteInput()).toBeDisabled();
  await proof.release();
  await expectStreamingAt(original.url);
  advance(60_001);
  await sendText(cdp, "same window after startup");
  expect(cdp.connections()).toBe(1);
});
test("browser-response-deadlines-052 Timing out a created tab preserves the original selection", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = viewer();
  await openPage();
  await expectStreamingAt(original.url);
  const created = cdp.holdNextNative("createTab");
  click(screen.getByLabelText("New tab"));
  await created.received;
  advance(29_999);
  expect(screen.queryByText("Reconnecting…")).toBeNull();
  advance(2);
  await screen.findByText("Reconnecting…");
  advance(1001);
  await expectStreamingAt(original.url);
  expect(
    screen.getByLabelText(original.title, { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    cdp.targets
      .filter((target) => {
        return target.windowId === original.windowId;
      })
      .map((target) => {
        return target.targetId;
      }),
  ).toStrictEqual([original.targetId, "created-1"]);
});
test("browser-response-deadlines-047 Selecting a sibling recovers input on the healthy wire", async () => {
  const sameWindow = { ...replacement, windowId: original.windowId };
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [original, sameWindow],
  });
  await openPage();
  await expectStreamingAt(original.url);
  const lookup = cdp.holdNextMembership(original.targetId);
  cdp.nativeEvent("tab-attached", sameWindow);
  await lookup.received;
  await lookup.releaseFailure("temporarily unavailable");
  await screen.findByText("Reconnecting…");
  expect(remoteInput()).toBeDisabled();
  click(screen.getByLabelText(sameWindow.title, { selector: '[role="tab"]' }));
  await expectStreamingAt(sameWindow.url);
  await sendText(cdp, "sibling control", sameWindow.targetId);
  expect(cdp.connections()).toBe(1);
});

test("browser-response-deadlines-050 Expired text input stays with the original attachment", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = viewer();
  await openPage();
  await expectStreamingAt(original.url);
  const before = cdp.pageSession(original.targetId);
  const receipt = cdp.holdNext("Input.insertText");
  await sendText(cdp, "x");
  await receipt.received;
  advance(29_999);
  expect(screen.queryByText("Reconnecting…")).toBeNull();
  advance(2);
  await screen.findByText("Reconnecting…");
  advance(1001);
  await expectStreamingAt(original.url);
  await sendText(cdp, "y");
  const current = cdp.pageSession(original.targetId);
  expect(current).not.toBe(before);
  const inserted = cdp.inputForTarget(original.targetId).filter((event) => {
    return event.method === "Input.insertText";
  });
  function textIn(sessionId: string | undefined) {
    return inserted
      .filter((event) => {
        return event.sessionId === sessionId;
      })
      .map((event) => {
        return event.params?.text;
      })
      .join("");
  }
  expect(textIn(before)).toBe("x");
  expect(textIn(current)).toBe("y");
});
test("browser-response-deadlines-054 Retiring the target with a pending attachment preserves original input", async () => {
  const errors = context.mocks.sentry();
  const advance = browserRecoveryClock(context.signal);
  const page = { ...replacement, windowId: original.windowId };
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [original, page],
  });
  await openPage();
  await expectStreamingAt(original.url);
  const attach = cdp.holdNext("Target.attachToTarget", page.targetId);
  click(screen.getByLabelText(page.title, { selector: '[role="tab"]' }));
  await attach.received;
  cdp.event("Target.targetDestroyed", { targetId: page.targetId });
  await expectStreamingAt(original.url);
  advance(30_001);
  await attach.release();
  await sendText(cdp, "original after retirement");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(errors.reports).toStrictEqual([]);
});

function observeCanvas() {
  const observations = new Map<Element, (visible: boolean) => void>();
  const show = (visible: boolean) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) {
      throw new Error("The browser canvas is missing");
    }
    const report = observations.get(canvas);
    if (!report) {
      throw new Error(
        "The displayed browser canvas has no intersection observer",
      );
    }
    report(visible);
  };
  const NativeObserver = IntersectionObserver;
  vi.stubGlobal(
    "IntersectionObserver",
    class extends NativeObserver {
      constructor(
        private readonly receive: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        super(receive, options);
      }
      override observe(element: Element) {
        super.observe(element);
        if (element instanceof HTMLCanvasElement) {
          observations.set(element, (visible) => {
            const bounds = element.getBoundingClientRect();
            this.receive(
              [
                {
                  target: element,
                  time: performance.now(),
                  boundingClientRect: bounds,
                  intersectionRect: bounds,
                  rootBounds: bounds,
                  intersectionRatio: visible ? 1 : 0,
                  isIntersecting: visible,
                },
              ],
              this,
            );
          });
        }
      }
      override unobserve(element: Element) {
        super.unobserve(element);
        observations.delete(element);
      }
    },
  );
  return show;
}

test("browser-response-deadlines-004 The original tab accepts input after setup completes with the browser canvas outside the viewport", async () => {
  const clock = browserRecoveryClock(context.signal);
  const show = observeCanvas();
  const { cdp, openPage } = viewer();
  const setup = cdp.holdNext("Page.enable");
  await openPage();
  await setup.received;

  show(false);
  const consumed = context.mocks.deferred<void>();
  await setup.release(undefined, () => {
    if (!consumed.settled()) {
      consumed.resolve();
    }
  });
  await consumed.promise;
  await screen.findByText("Viewing paused");
  expect(remoteInput()).toBeDisabled();
  clock(121_000);
  show(true);
  await expectStreamingAt(original.url);
  await sendText(cdp, "viewport restored to original");
  expect(cdp.connections()).toBe(1);
});

test("An empty assigned window can create a usable tab with the version reply held past 31 seconds", async () => {
  const clock = browserRecoveryClock(context.signal);
  const { cdp, openPage } = arrangeNativePage(context, { targets: [] });
  const version = cdp.holdNext("Browser.getVersion");
  const discovery = cdp.holdNext("Target.getTargets");
  await openPage();
  await version.received;
  clock(31_001);
  await discovery.received;
  await discovery.release({ targetInfos: [] });
  await screen.findByText("No tabs open");
  const create = await screen.findByLabelText("New tab", {
    selector: "button[data-browser-new-tab]",
  });
  expect(create).toBeEnabled();
  click(create);
  await expectStreamingAt("");
  expect(cdp.targets).toContainEqual(
    expect.objectContaining({ url: "about:blank" }),
  );
  await waitFor(() => {
    return expect(
      cdp.requests.some((request) => {
        return request.method === "Target.getTargets";
      }),
    ).toBeTruthy();
  });
  expect(cdp.connections()).toBe(1);
});

test.each(["released", "withheld"] as const)(
  "The replacement viewer accepts typing with the expired handshake %s",
  async (reply) => {
    const advance = browserRecoveryClock(context.signal);
    const documentState = context.mocks.browser.visibilityState("visible");
    const { cdp, openPage } = viewer();
    const firstHandshake = cdp.holdNextNative("hello");
    await openPage();
    await firstHandshake.received;
    documentState.changeTo("hidden");
    await screen.findByText("Viewing paused");
    advance(30_001);
    await waitFor(() => {
      expect(cdp.activeConnections()).toBe(0);
    });
    expect(remoteInput()).toBeDisabled();
    documentState.changeTo("visible");
    if (reply === "released") {
      await firstHandshake.release();
    }
    advance(1001);
    await expectStreamingAt(original.url);
    await sendText(cdp, "dispatch after the paused handshake");
    expect(cdp.connections()).toBe(2);
    expect(cdp.activeConnections()).toBe(1);
  },
);

test.each(["deliver", "withhold"] as const)(
  "Replacement page receives typing when the pending descriptor expires and its original reply is %s",
  async (late) => {
    const advance = browserRecoveryClock(context.signal);
    const {
      openPage,
      cdp,
      viewer: connection,
    } = arrangeNativePage(context, { targets: [original, replacement] });
    await openPage();
    await expectStreamingAt(original.url);
    const received = context.mocks.deferred<void>();
    const answer = context.mocks.deferred<void>();
    const updatedBrowser = {
      ...connection.browser,
      window: {
        ...connection.browser.window!,
        primaryWindowId: replacement.windowId,
      },
    };
    const delivered = context.mocks.deferred<void>();
    const read = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(async function (
      this: Response,
    ) {
      const value: unknown = await read.call(this);
      if (
        isRecord(value) &&
        isRecord(value.browser) &&
        value.browser.name === "Previous voyage" &&
        !delivered.settled()
      ) {
        delivered.resolve();
      }
      return value;
    });
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: updatedBrowser });
    });
    context.mocks.api(browserContract.get, async ({ respond }) => {
      if (!received.settled()) {
        received.resolve();
        await answer.promise;
        const stale = { ...connection.browser, name: "Previous voyage" };
        return respond(200, {
          browser: stale,
          viewer: { ...connection, browser: stale },
        });
      }
      return respond(200, {
        browser: updatedBrowser,
        viewer: { ...connection, browser: updatedBrowser },
      });
    });
    context.mocks.ably.trigger("browserSessionChanged", {
      threadId: connection.browser.threadId,
    });
    try {
      await received.promise;
      await waitFor(() => {
        return expect(remoteInput()).toBeDisabled();
      });
      expect(remoteInput().closest('[aria-hidden="true"]')).toBeNull();
      advance(60_001);
      await screen.findByText("Reconnecting…");
      advance(4000);
      await expectStreamingAt(replacement.url);
      await sendText(cdp, "inspect the new map", replacement.targetId);
      if (late === "deliver") {
        answer.resolve();
        await delivered.promise;
      }
      await sendText(cdp, "check after deadline", replacement.targetId);
      expect(cdp.inputForTarget(original.targetId)).not.toContainEqual(
        expect.objectContaining({ params: { text: "check after deadline" } }),
      );
    } finally {
      if (!answer.settled()) {
        answer.resolve();
      }
    }
  },
);

async function acknowledgeCapture(
  capture: ReturnType<ReturnType<typeof viewer>["cdp"]["holdNext"]>,
) {
  const received = context.mocks.deferred<void>();
  await capture.release(undefined, () => {
    if (!received.settled()) {
      received.resolve();
    }
  });
  await act(async () => {
    await received.promise;
  });
}

test("browser-response-deadlines-024 A wall-clock rollback cannot revive an expired recovery capture", async () => {
  const advance = browserRecoveryClock(context.signal);
  let wall = Date.UTC(2026, 8, 5);
  mockNow(() => {
    return wall;
  }, context.signal);
  const { cdp, openPage } = viewer();
  await openPage();
  await expectStreamingAt(original.url);
  const capture = cdp.holdNext("Page.startScreencast");
  const picture = cdp.holdTargetFrames(original.targetId);
  cdp.disconnect({ code: 1006 });
  await screen.findByText("Reconnecting…");
  advance(4000);
  await capture.received;
  await picture.received;
  await acknowledgeCapture(capture);
  const stopped = cdp.holdNext("Page.stopScreencast");
  wall -= 3_600_000;
  advance(30_001);
  await stopped.received;
  expect(remoteInput()).toBeDisabled();
  await screen.findByText("Reconnecting…");
  picture.release();
  const next = cdp.holdTargetFrames(original.targetId);
  await stopped.release();
  expect(remoteInput()).toBeDisabled();
  advance(4000);
  await next.received;
  expect(remoteInput()).toBeDisabled();
  next.release();
  await expectStreamingAt(original.url);
  await sendText(cdp, "arrival after rollback");
});

test("browser-response-deadlines-029 A slow capture acknowledgement starts its own image budget on the selected page", async () => {
  const advance = browserRecoveryClock(context.signal);
  const sibling = { ...replacement, windowId: original.windowId };
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [original, sibling],
  });
  await openPage();
  await expectStreamingAt(original.url);
  const paint = cdp.holdTargetFrames(sibling.targetId);
  const capture = cdp.holdNext("Page.startScreencast");
  click(screen.getByLabelText(sibling.title, { selector: '[role="tab"]' }));
  await paint.received;
  await capture.received;
  advance(20_000);
  await acknowledgeCapture(capture);
  const stop = cdp.holdNext("Page.stopScreencast");
  advance(29_999);
  expect(screen.queryByText("Reconnecting…")).toBeNull();
  advance(2);
  await stop.received;
  await screen.findByText("Reconnecting…");
  expect(cdp.connections()).toBe(1);
  paint.release();
  await stop.release();
  advance(4000);
  await expectStreamingAt(sibling.url);
  await sendText(cdp, "observed on replacement", sibling.targetId);
});

test("browser-response-deadlines-026 A sibling receives keyboard input after two expired first images", async () => {
  const advance = browserRecoveryClock(context.signal);
  const sibling = { ...replacement, windowId: original.windowId };
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [original, sibling],
  });
  await openPage();
  await expectStreamingAt(original.url);
  await sendText(cdp, "before selecting sibling");
  const tab = screen.getByLabelText(original.title, {
    selector: '[role="tab"]',
  });
  let paint = cdp.holdTargetFrames(sibling.targetId);
  let capture = cdp.holdNext("Page.startScreencast");
  click(screen.getByLabelText(sibling.title, { selector: '[role="tab"]' }));
  for (const attempt of [1, 2]) {
    await paint.received;
    await capture.received;
    await acknowledgeCapture(capture);
    const stop = cdp.holdNext("Page.stopScreencast");
    advance(30_001);
    await stop.received;
    await screen.findByText("Reconnecting…");
    expect(tab).not.toHaveAttribute("aria-disabled", "true");
    expect(remoteInput()).toBeDisabled();
    paint.release();
    await stop.release();
    if (attempt === 1) {
      paint = cdp.holdTargetFrames(sibling.targetId);
      capture = cdp.holdNext("Page.startScreencast");
    }
    advance(4000);
  }
  await expectStreamingAt(sibling.url);
  await sendText(cdp, "the sibling receives this", sibling.targetId);
});

test("browser-response-deadlines-031 Releasing the expired capture and its stop cannot interrupt the other tab", async () => {
  const advance = browserRecoveryClock(context.signal);
  const visibility = context.mocks.browser.visibilityState("visible");
  const sibling = { ...replacement, windowId: original.windowId };
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [original, sibling],
  });
  await openPage();
  await expectStreamingAt(original.url);
  visibility.changeTo("hidden");
  await screen.findByText("Viewing paused");
  const paint = cdp.holdTargetFrames(original.targetId);
  const capture = cdp.holdNext("Page.startScreencast");
  visibility.changeTo("visible");
  await paint.received;
  await capture.received;
  await acknowledgeCapture(capture);
  const stop = cdp.holdNext("Page.stopScreencast");
  advance(30_001);
  await stop.received;
  click(screen.getByLabelText(sibling.title, { selector: '[role="tab"]' }));
  await expectStreamingAt(sibling.url);
  await stop.release();
  paint.release();
  await sendText(cdp, "input after stale cleanup", sibling.targetId);
  expect(screen.getByLabelText("Address")).toHaveValue(sibling.url);
});

test("browser-response-deadlines-034 A paused mode switch yields to the assigned replacement window", async () => {
  const viewport = observeCanvas();
  const {
    cdp,
    openPage,
    viewer: descriptor,
  } = arrangeNativePage(context, { targets: [original, replacement] });
  await openPage();
  await expectStreamingAt(original.url);
  const pending = cdp.holdNextNative("hello");
  async function modes() {
    click(screen.getByLabelText("Browser settings"));
    click(await screen.findByText("Connection mode"));
    return (await screen.findByText("Shared connection")).closest<HTMLElement>(
      '[role="menuitemradio"]',
    )!;
  }
  await modes();
  click(await screen.findByText("Separate image connection"));
  await pending.received;
  viewport(false);
  await screen.findByText("Viewing paused");
  await expect(modes()).resolves.toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}{Escape}");
  const browser = {
    ...descriptor.browser,
    window: {
      ...descriptor.browser.window!,
      primaryWindowId: replacement.windowId,
    },
  };
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser });
  });
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (!requested.settled()) {
      requested.resolve();
    }
    await release.promise;
    return respond(200, { browser, viewer: { ...descriptor, browser } });
  });
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: browser.threadId,
  });
  await requested.promise;
  expect(remoteInput()).toBeDisabled();
  release.resolve();
  const option = await modes();
  await waitFor(() => {
    return expect(option).not.toHaveAttribute("aria-disabled", "true");
  });
  await userEvent.keyboard("{Escape}{Escape}");
  viewport(true);
  await expectStreamingAt(replacement.url);
  await pending.release();
  await sendText(cdp, "belongs to the new window", replacement.targetId);
  expect(cdp.inputForTarget(original.targetId)).not.toContainEqual(
    expect.objectContaining({ params: { text: "belongs to the new window" } }),
  );
});

test("browser-response-deadlines-051 A completed navigation stays at its destination after its acknowledgement expires", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = viewer();
  await openPage();
  await expectStreamingAt(original.url);
  const response = cdp.holdNext("Page.navigate");
  const address = screen.getByRole("textbox", { name: "Address" });
  const destination = "https://harbor.example.test/arrival";
  await fill(address, destination);
  await userEvent.keyboard("{Enter}");
  await response.received;
  await waitFor(() => {
    return expect(
      cdp.targets.find((target) => {
        return target.targetId === original.targetId;
      })?.url,
    ).toBe(destination);
  });
  advance(30_001);
  await screen.findByText("Reconnecting…");
  advance(4000);
  await expectStreamingAt(destination);
  await sendText(cdp, "arrived while the reply was withheld");
  await response.release();
  await sendText(cdp, "same document after the late reply");
  const deliveries = cdp.requests.filter((request) => {
    return request.method === "Page.navigate";
  });
  expect(
    deliveries.map((request) => {
      return request.params;
    }),
  ).toStrictEqual([{ url: destination }]);
});

test("browser-response-deadlines-018 A consumed server failure precedes the replacement window's second disconnect", async () => {
  const advance = browserRecoveryClock(context.signal);
  const {
    cdp,
    openPage,
    viewer: initial,
  } = arrangeNativePage(context, { targets: [original, replacement] });
  await openPage();
  await expectStreamingAt(original.url);
  const consumed = context.mocks.deferred<void>();
  const originalJson = Response.prototype.json;
  vi.spyOn(Response.prototype, "json").mockImplementation(async function (
    this: Response,
  ) {
    const body: unknown = await originalJson.call(this);
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      body.error.message === "First descriptor unavailable" &&
      !consumed.settled()
    ) {
      consumed.resolve();
    }
    return body;
  });
  let failed = false;
  let replacementAllowed = false;
  const changed = {
    ...initial.browser,
    window: {
      ...initial.browser.window!,
      primaryWindowId: replacement.windowId,
    },
  };
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, {
      browser: replacementAllowed ? changed : initial.browser,
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    if (!failed) {
      failed = true;
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "First descriptor unavailable",
        },
      });
    }
    return respond(200, {
      browser: changed,
      viewer: { ...initial, browser: changed },
    });
  });
  cdp.disconnect({ code: 1006 });
  await screen.findByText("Reconnecting…");
  advance(1000);
  await consumed.promise;
  await screen.findByText("First descriptor unavailable");
  replacementAllowed = true;
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: changed.threadId,
  });
  advance(4000);
  await expectStreamingAt(replacement.url);
  const next = cdp.holdNextNative("hello");
  cdp.disconnect({ code: 1006 });
  await screen.findByText("Reconnecting…");
  advance(1000);
  await next.received;
  expect(
    screen.queryByText(/browser action could not be completed/i),
  ).toBeNull();
  await next.release();
  await expectStreamingAt(replacement.url);
  expect(
    screen.getByLabelText("New tab", {
      selector: "button[data-browser-new-tab]",
    }),
  ).toBeEnabled();
  await sendText(
    cdp,
    "replacement after second interruption",
    replacement.targetId,
  );
});

test("browser-response-deadlines-035 The current connection mode recovers the original target through two native proof failures", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = viewer();
  await openPage();
  await expectStreamingAt(original.url);
  cdp.failNext(
    "Runtime.evaluate",
    "Temporary inventory read unavailable",
    -32_001,
  );
  cdp.nativeEvent("tab-attached", original);
  await screen.findByText("Reconnecting…");
  const old = cdp.holdNextNative("getWindow");
  advance(4000);
  await old.received;
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  click(await screen.findByText("Separate image connection"));
  await expectStreamingAt(original.url);
  cdp.failNext(
    "Runtime.evaluate",
    "Current native inventory interrupted",
    -32_001,
  );
  cdp.nativeEvent("tab-attached", original);
  await screen.findByText("Reconnecting…");
  expect(remoteInput()).toBeDisabled();
  advance(4000);
  await expectStreamingAt(original.url);
  await old.release();
  await sendText(cdp, "after both native proofs");
});

test("browser-response-deadlines-009 Only the replacement accepts input after the first descriptor times out", async () => {
  const advance = browserRecoveryClock(context.signal);
  const {
    openPage,
    cdp,
    viewer: previous,
  } = arrangeNativePage(context, { targets: [original, replacement] });
  const first = context.mocks.deferred<void>();
  const late = context.mocks.deferred<void>();
  const next = {
    ...previous.browser,
    window: {
      ...previous.browser.window!,
      primaryWindowId: replacement.windowId,
    },
  };
  let retired = false,
    read = false;
  const parse = Response.prototype.json;
  vi.spyOn(Response.prototype, "json").mockImplementation(async function (
    this: Response,
  ) {
    const value: unknown = await parse.call(this);
    if (
      isRecord(value) &&
      isRecord(value.browser) &&
      value.browser.name === "Held first catalog"
    ) {
      read = true;
    }
    return value;
  });
  context.mocks.api(browserContract.get, async ({ respond, request }) => {
    if (!first.settled()) {
      first.resolve();
      await late.promise;
      retired = request.signal.aborted;
      const stale = { ...previous.browser, name: "Held first catalog" };
      return respond(200, {
        browser: stale,
        viewer: { ...previous, browser: stale },
      });
    }
    return respond(200, {
      browser: next,
      viewer: { ...previous, browser: next },
    });
  });
  await openPage();
  await first.promise;
  advance(60_001);
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: next });
  });
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: next.threadId,
  });
  advance(4000);
  await expectStreamingAt(replacement.url);
  late.resolve();
  await sendText(cdp, "after first catalog", replacement.targetId);
  expect(cdp.connections()).toBe(1);
  expect(
    screen.queryByLabelText(original.title, { selector: '[role="tab"]' }),
  ).toBeNull();
  expect({ retired, read }).toStrictEqual({ retired: false, read: true });
});

test("browser-response-deadlines-011 Three image setup phases share the deadline before a single recovery descriptor", async () => {
  const advance = browserRecoveryClock(context.signal);
  const recoveryEndpoint = "wss://peer.example.test/after-image-deadline";
  const {
    cdp,
    openPage,
    viewer: descriptor,
  } = arrangeNativePage(context, {
    targets: [original],
    endpointAliases: [recoveryEndpoint],
  });
  const initial = context.mocks.deferred<void>();
  const recovery = context.mocks.deferred<void>();
  let expired = false;
  let outsideBudget = false;
  context.mocks.api(browserContract.get, ({ respond }) => {
    if (!initial.settled()) {
      initial.resolve();
      return respond(200, { browser: descriptor.browser, viewer: descriptor });
    }
    if (!expired || recovery.settled()) {
      outsideBudget = true;
      return respond(503, {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Recovery descriptor already allocated or requested early",
        },
      });
    }
    recovery.resolve();
    return respond(200, {
      browser: descriptor.browser,
      viewer: { ...descriptor, cdpUrl: recoveryEndpoint },
    });
  });
  await openPage();
  await expectStreamingAt(original.url);
  await initial.promise;
  const attach = cdp.holdNext("Target.attachToTarget", "okou-worker");
  const hello = cdp.holdNextNative("hello");
  const proof = cdp.holdNextNative("getWindow");
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  click(await screen.findByText("Separate image connection"));
  await attach.received;
  advance(21_000);
  await attach.release();
  await hello.received;
  advance(21_000);
  await hello.release();
  await proof.received;
  advance(17_999);
  expect(remoteInput()).toBeDisabled();
  expect(recovery.settled()).toBeFalsy();
  expired = true;
  advance(1001);
  await screen.findByText("Reconnecting…");
  advance(4000);
  await recovery.promise;
  await expectStreamingAt(original.url);
  await proof.release();
  await sendText(cdp, "after the shared budget");
  expect(cdp.requestsAt(recoveryEndpoint)).toContainEqual(
    expect.objectContaining({
      method: "Input.insertText",
      params: expect.objectContaining({ text: "after the shared budget" }),
    }),
  );
  expect(outsideBudget).toBeFalsy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("browser-response-deadlines-043 A late window read cannot displace the recovered original tab", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = viewer();
  await openPage();
  await expectStreamingAt(original.url);
  const before = cdp.connections(),
    proof = cdp.holdNextNative("getWindow");
  act(() => {
    return cdp.nativeEvent("tab-attached", original);
  });
  await proof.received;
  advance(31_000);
  await screen.findByText("Reconnecting…");
  expect(remoteInput()).toBeDisabled();
  expect(
    screen.getByLabelText("New tab", {
      selector: "button[data-browser-new-tab]",
    }),
  ).toBeDisabled();
  advance(4000);
  await expectStreamingAt(original.url);
  let read = false;
  await proof.release(() => {
    read = true;
  });
  await sendText(cdp, "late window inventory");
  expect(cdp.connections()).toBe(before);
  expect(read).toBeTruthy();
});
