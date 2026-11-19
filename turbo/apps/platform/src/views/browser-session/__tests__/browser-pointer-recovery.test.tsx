import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { click, fill } from "../../../__tests__/page-helper.ts";
import { setupSentryLogger } from "../../../lib/sentry-config.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const home = "https://example.com";
const sibling = "https://other.example";

async function openPointerFixture() {
  const sentry = context.mocks.sentry();
  setupSentryLogger();
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [
      { targetId: "example-page", title: "Example", url: home, windowId: 101 },
      { targetId: "other-page", title: "Other", url: sibling, windowId: 101 },
    ],
  });
  await openPage();
  await expectStreamingAt(home);
  const canvas = screen.getByRole("img", { name: "Live browser view" });
  const surface = canvas.closest("[data-browser-surface]");
  if (!(surface instanceof HTMLElement)) {
    throw new Error("Browser pointer surface unavailable");
  }
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1440, 900),
  );
  return {
    cdp,
    surface,
    sentry,
    session: cdp.pageSession("example-page"),
  };
}

function mouse(clientX: number, clientY: number, buttons = 0) {
  return {
    clientX,
    clientY,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons,
  };
}

function typeRemote(text: string) {
  const input = screen.getByLabelText("Remote browser input");
  input.focus();
  fireEvent.input(input, {
    target: { value: text },
    data: text,
    inputType: "insertText",
  });
}

async function navigateTo(url: string) {
  await fill(screen.getByLabelText("Address"), url);
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
  await expectStreamingAt(url);
}

test("Recover on the sibling when the hovered tab is destroyed before acknowledgement", async () => {
  const { cdp, surface, session } = await openPointerFixture();
  const hover = cdp.holdNext("Input.dispatchMouseEvent");
  fireEvent.pointerMove(surface, mouse(120, 130));
  await hover.received;
  const move = expect.objectContaining({
    method: "Input.dispatchMouseEvent",
    params: expect.objectContaining({ type: "mouseMoved", x: 120, y: 130 }),
  });
  expect(cdp.input).toEqual([move]);
  expect(cdp.input[0]?.sessionId).toBe(session);

  cdp.event("Target.targetDestroyed", { targetId: "example-page" });
  await expectStreamingAt(sibling);
  await hover.release();
  typeRemote("other page text");
  await waitFor(() => {
    expect(cdp.input).toContainEqual({
      method: "Input.insertText",
      params: { text: "other page text" },
      sessionId: cdp.pageSession("other-page"),
    });
  });
  await navigateTo("https://recovered.example/");
  expect(
    cdp.input.filter((item) => {
      return item.method === "Input.dispatchMouseEvent";
    }),
  ).toEqual([move]);
});

test("Keep the original drag failure and fence the detached tab", async () => {
  const { cdp, surface, session, sentry } = await openPointerFixture();
  fireEvent.pointerDown(surface, mouse(120, 130, 1));
  fireEvent.mouseDown(surface, mouse(120, 130, 1));
  await waitFor(() => {
    expect(cdp.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchMouseEvent",
        params: expect.objectContaining({ type: "mousePressed" }),
        sessionId: session,
      }),
    );
  });
  const drag = cdp.holdNext("Input.dispatchMouseEvent");
  fireEvent.pointerMove(surface, mouse(220, 230, 1));
  await drag.received;
  expect(cdp.input).toContainEqual(
    expect.objectContaining({
      method: "Input.dispatchMouseEvent",
      params: expect.objectContaining({ type: "mouseMoved", buttons: 1 }),
      sessionId: session,
    }),
  );

  cdp.event("Target.detachedFromTarget", { sessionId: session });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({
          request: expect.objectContaining({
            method: "Input.dispatchMouseEvent",
          }),
        }),
      }),
    );
  });
  const failure = screen.getByRole("alert").textContent;
  await drag.release();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(failure ?? "");
  click(await screen.findByText("Other"));
  await expectStreamingAt(sibling);
});

test("Preserve the failed release of a held key when neutral hover is interrupted", async () => {
  const { cdp, surface, session, sentry } = await openPointerFixture();
  const input = screen.getByLabelText("Remote browser input");
  input.focus();
  fireEvent.keyDown(input, { key: "ArrowLeft", code: "ArrowLeft" });
  await waitFor(() => {
    expect(cdp.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        params: expect.objectContaining({ key: "ArrowLeft" }),
        sessionId: session,
      }),
    );
  });
  const hover = cdp.holdNext("Input.dispatchMouseEvent");
  fireEvent.pointerMove(surface, mouse(120, 130));
  await hover.received;

  cdp.event("Target.detachedFromTarget", { sessionId: session });
  await hover.release();

  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({
          message: expect.stringMatching(/cleanup|release/iu),
          request: expect.objectContaining({
            method: "Input.dispatchKeyEvent",
          }),
        }),
      }),
    );
  });
});

test("Retain an earlier native hover rejection when the next hover detaches", async () => {
  const { cdp, surface, session, sentry } = await openPointerFixture();
  cdp.failNext("Input.dispatchMouseEvent", "Original hover rejected", -32001);
  const rejected = cdp.holdNext("Input.dispatchMouseEvent");
  fireEvent.pointerMove(surface, mouse(120, 130));
  await rejected.received;
  const hover = cdp.holdNext("Input.dispatchMouseEvent");
  fireEvent.pointerMove(surface, mouse(220, 230));
  await hover.received;
  await rejected.release();
  cdp.event("Target.detachedFromTarget", { sessionId: session });
  await hover.release();

  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({
          request: { method: "Input.dispatchMouseEvent", code: -32001 },
        }),
      }),
    );
  });
  click(await screen.findByText("Other"));
  await expectStreamingAt(sibling);
});
