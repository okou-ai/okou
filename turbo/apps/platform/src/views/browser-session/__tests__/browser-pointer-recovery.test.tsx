import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const board = "https://studio.example/board";
const notes = "https://studio.example/notes";

async function openStudio() {
  const page = arrangeNativePage(context, {
    targets: [
      { targetId: "board", title: "Drawing board", url: board, windowId: 101 },
      { targetId: "notes", title: "Project notes", url: notes, windowId: 101 },
    ],
  });
  await page.openPage();
  await expectStreamingAt(board);
  const image = screen.getByRole("img", { name: "Live browser view" });
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1440, 900),
  );
  return { cdp: page.cdp, image, original: page.cdp.pageSession("board") };
}

function move(image: HTMLElement, x: number, buttons = 0) {
  fireEvent.pointerMove(image, {
    pointerType: "mouse",
    pointerId: 1,
    buttons,
    clientX: x,
    clientY: 120,
  });
}

type BrowserPeer = Awaited<ReturnType<typeof openStudio>>["cdp"];

async function writeNote(peer: BrowserPeer, text: string) {
  const input = screen.getByLabelText("Remote browser input");
  input.focus();
  fireEvent.input(input, {
    target: { value: text },
    data: text,
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(peer.input).toContainEqual({
      sessionId: peer.pageSession("notes"),
      method: "Input.insertText",
      params: { text },
    });
  });
}

test("browser-pointer-recovery-002 a removed drawing tab hands text and navigation to its sibling without replaying hover", async () => {
  const { cdp, image, original } = await openStudio();
  const hover = cdp.holdNext("Input.dispatchMouseEvent");
  move(image, 240);
  await hover.received;
  const oldPosition = expect.objectContaining({
    type: "mouseMoved",
    buttons: 0,
    modifiers: 0,
    x: 240,
    y: 120,
  });
  expect(cdp.input).toContainEqual({
    method: "Input.dispatchMouseEvent",
    sessionId: original,
    params: oldPosition,
  });
  cdp.event("Target.targetDestroyed", { targetId: "board" });
  await screen.findByLabelText("Project notes", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  await expectStreamingAt(notes);
  const delivered = new Set(cdp.input);
  await act(() => {
    return hover.release();
  });
  // Exercise the successor's own pointer stream, at a distinguishable position.
  move(screen.getByRole("img", { name: "Live browser view" }), 640);
  await waitFor(() => {
    expect(cdp.input).toContainEqual({
      sessionId: cdp.pageSession("notes"),
      method: "Input.dispatchMouseEvent",
      params: expect.objectContaining({ type: "mouseMoved", x: 640, y: 120 }),
    });
  });
  const afterReply = cdp.input.filter((event) => {
    return !delivered.has(event);
  });
  expect(afterReply).not.toContainEqual(
    expect.objectContaining({
      method: "Input.dispatchMouseEvent",
      params: oldPosition,
    }),
  );
  await writeNote(cdp, "Move to archive");
  const destination = "https://archive.example/sketches";
  fireEvent.change(screen.getByLabelText("Address"), {
    target: { value: destination },
  });
  click(screen.getByLabelText("Open address"));
  await screen.findByLabelText("archive.example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  await expectStreamingAt(destination);
});

test("browser-pointer-recovery-005 the interrupted drag fences its tab while notes remain editable", async () => {
  const telemetry = context.mocks.sentry();
  const { cdp, image, original } = await openStudio();
  const press = {
    pointerType: "mouse",
    pointerId: 1,
    button: 0,
    buttons: 1,
    clientX: 180,
    clientY: 120,
    detail: 1,
  };
  fireEvent.pointerDown(image, press);
  fireEvent.mouseDown(image, press);
  await waitFor(() => {
    expect(cdp.input).toContainEqual({
      method: "Input.dispatchMouseEvent",
      sessionId: original,
      params: expect.objectContaining({ type: "mousePressed", button: "left" }),
    });
  });
  const drag = cdp.holdNext("Input.dispatchMouseEvent");
  move(image, 380, 1);
  await drag.received;
  expect(cdp.input).toContainEqual({
    method: "Input.dispatchMouseEvent",
    sessionId: original,
    params: expect.objectContaining({ type: "mouseMoved", buttons: 1, x: 380 }),
  });
  cdp.event("Target.detachedFromTarget", { sessionId: original });
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(telemetry.reports).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Original input cleanup is unconfirmed.",
          request: { method: "Input.dispatchMouseEvent" },
        }),
      }),
    );
  });
  await act(() => {
    return drag.release();
  });
  expect(
    screen.getByLabelText("Drawing board", {
      selector: '[role="tab"][aria-selected="true"]',
    }),
  ).toBeVisible();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(screen.getByLabelText("Project notes", { selector: '[role="tab"]' }));
  await expectStreamingAt(notes);
  await writeNote(cdp, "Record interrupted stroke");
  click(screen.getByLabelText("Drawing board", { selector: '[role="tab"]' }));
  await screen.findByLabelText("Drawing board", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
});

test("browser-pointer-recovery-007 a neutral hover cannot replace the held key's release failure", async () => {
  const telemetry = context.mocks.sentry();
  const { cdp, image, original } = await openStudio();
  const keyboard = screen.getByLabelText("Remote browser input");
  keyboard.focus();
  fireEvent.keyDown(keyboard, {
    key: "ArrowLeft",
    code: "ArrowLeft",
    keyCode: 37,
  });
  await waitFor(() => {
    expect(cdp.input).toContainEqual({
      method: "Input.dispatchKeyEvent",
      sessionId: original,
      params: expect.objectContaining({ key: "ArrowLeft" }),
    });
  });
  const hover = cdp.holdNext("Input.dispatchMouseEvent");
  move(image, 500);
  await hover.received;
  expect(cdp.input).toContainEqual({
    method: "Input.dispatchMouseEvent",
    sessionId: original,
    params: expect.objectContaining({
      type: "mouseMoved",
      buttons: 0,
      modifiers: 0,
    }),
  });
  cdp.event("Target.detachedFromTarget", { sessionId: original });
  await screen.findByText("Browser view unavailable");
  expect(keyboard).toBeDisabled();
  expect(cdp.requests).toContainEqual(
    expect.objectContaining({
      sessionId: original,
      method: "Input.dispatchKeyEvent",
      params: expect.objectContaining({ type: "keyUp", key: "ArrowLeft" }),
    }),
  );
  await waitFor(() => {
    expect(telemetry.reports).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          request: expect.objectContaining({
            method: "Input.dispatchKeyEvent",
            code: -32_001,
          }),
        }),
      }),
    );
  });
});
