import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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
  target = original.targetId,
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
    if (awaitingRefresh && !refresh.settled()) refresh.resolve();
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
test("browser-response-deadlines-018 A replacement reconnect clears the failed browser action", async () => {
  const advance = browserRecoveryClock(context.signal);
  const {
    cdp,
    viewer: descriptor,
    openPage,
  } = arrangeNativePage(context, { targets: [original, replacement] });
  const next = {
    ...descriptor,
    browser: {
      ...descriptor.browser,
      window: {
        ...descriptor.browser.window!,
        primaryWindowId: replacement.windowId,
      },
    },
  };
  let server: "initial" | "failed" | "replacement" = "initial";
  const failed = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, ({ respond }) => {
    if (server === "failed") {
      if (!failed.settled()) failed.resolve();
      return respond(500, {
        error: { message: "Temporary failure", code: "internal_error" },
      });
    }
    const active = server === "initial" ? descriptor : next;
    return respond(200, { browser: active.browser, viewer: active });
  });
  await openPage();
  await expectStreamingAt(original.url);
  server = "failed";
  cdp.disconnect({ code: 1006 });
  await screen.findByText("Reconnecting…");
  advance(1001);
  await failed.promise;
  server = "replacement";
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: descriptor.browser.threadId,
  });
  await expectStreamingAt(replacement.url);
  cdp.disconnect({ code: 1006 });
  await screen.findByText("Reconnecting…");
  expect(
    screen.queryByText(
      "The browser action could not be completed. Check the browser before trying again.",
    ),
  ).toBeNull();
  advance(1001);
  await expectStreamingAt(replacement.url);
  expect(screen.getByLabelText("New tab")).toBeEnabled();
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
  ).toEqual([original.targetId, "created-1"]);
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
