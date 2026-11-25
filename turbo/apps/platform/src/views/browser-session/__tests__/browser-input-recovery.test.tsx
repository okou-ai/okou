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

test("browser-pointer-recovery-008 the rejected hover remains attributed to the drawing page after a later hover loses its session", async () => {
  const diagnostic = context.mocks.sentry();
  const { cdp, image, original } = await openStudio();
  const rejected = cdp.holdNext("Input.dispatchMouseEvent");
  cdp.failNext("Input.dispatchMouseEvent", "Drawing cursor refused", -32_017);
  move(image, 275);
  await rejected.received;
  await act(() => {
    return rejected.release();
  });
  const pending = cdp.holdNext("Input.dispatchMouseEvent");
  move(image, 590);
  await pending.received;
  expect(cdp.input).toContainEqual({
    method: "Input.dispatchMouseEvent",
    sessionId: original,
    params: expect.objectContaining({
      type: "mouseMoved",
      button: "none",
      buttons: 0,
      modifiers: 0,
      x: 590,
    }),
  });
  const beforeDetach = diagnostic.reports.length;
  cdp.event("Target.detachedFromTarget", { sessionId: original });
  await screen.findByText("Browser view unavailable");
  await act(() => {
    return pending.release();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(diagnostic.reports.slice(beforeDetach)).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          request: { method: "Input.dispatchMouseEvent", code: -32_017 },
        }),
        context: expect.objectContaining({
          tags: expect.objectContaining({ browser_event: "recovery-stopped" }),
        }),
      }),
    );
  });
  click(screen.getByLabelText("Project notes", { selector: '[role="tab"]' }));
  await expectStreamingAt(notes);
  await writeNote(cdp, "Cursor rejected on board");
});

const primary = "https://plan.example/floor";
const alternate = "https://plan.example/elevation";

async function openPlans(box = new DOMRect(0, 0, 1440, 900)) {
  const { cdp, openPage } = arrangeNativePage(
    context,
    {
      targets: [
        { targetId: "floor", windowId: 207, title: "Floor plan", url: primary },
        {
          targetId: "elevation",
          windowId: 207,
          title: "Elevation plan",
          url: alternate,
        },
      ],
    },
    207,
  );
  await openPage();
  await expectStreamingAt(primary);
  const image = screen.getByRole("img", { name: "Live browser view" });
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(box);
  return { cdp, image };
}

function contact(id: number, x: number, y: number) {
  return {
    pointerId: id,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: x,
    clientY: y,
  };
}
function tap(image: HTMLElement, id: number, x: number, y: number) {
  const point = contact(id, x, y);
  fireEvent.pointerDown(image, { ...point, buttons: 1 });
  fireEvent.pointerUp(image, { ...point, buttons: 0 });
}
function stroke(sessionId: string, x: number, y: number) {
  return ["mousePressed", "mouseReleased"].map((type) => {
    return {
      sessionId,
      method: "Input.dispatchMouseEvent",
      params: expect.objectContaining({
        type,
        button: "left",
        clickCount: 1,
        x,
        y,
      }),
    };
  });
}

test("browser-touch-regression-01 the floor plan receives the jittered tap at lift-off and gains keyboard focus", async () => {
  const { image, cdp } = await openPlans();
  const down = contact(11, 280, 300);
  const up = contact(11, 282, 303);
  fireEvent.pointerDown(image, { ...down, buttons: 1 });
  fireEvent.pointerMove(image, { ...up, buttons: 1 });
  fireEvent.pointerUp(image, up);
  await waitFor(() => {
    expect(cdp.input).toStrictEqual(stroke(cdp.pageSession("floor"), 282, 303));
  });
  await act(() => {
    fireEvent.mouseDown(image, { ...up, buttons: 1, detail: 1 });
    fireEvent.mouseUp(image, { ...up, buttons: 0, detail: 1 });
    fireEvent.click(image, { ...up, detail: 1 });
  });
  expect(cdp.input).toStrictEqual(stroke(cdp.pageSession("floor"), 282, 303));
  expect(screen.getByLabelText("Remote browser input")).toHaveFocus();
});

test("browser-touch-regression-03.01 cancelling a contact leaves only the fresh floor-plan tap", async () => {
  const { image, cdp } = await openPlans();
  const first = contact(18, 390, 190);
  fireEvent.pointerDown(image, { ...first, buttons: 1 });
  fireEvent.pointerCancel(image, first);
  fireEvent.pointerUp(image, first);
  tap(image, 19, 816, 432);
  await waitFor(() => {
    expect(cdp.input).toStrictEqual(stroke(cdp.pageSession("floor"), 816, 432));
  });
});

test("browser-touch-regression-04 a tap in the top margin misses while the image maps the next tap to the plan", async () => {
  // A 720 by 450 picture is centered vertically within a 720 by 650 box.
  const { image, cdp } = await openPlans(new DOMRect(20, 40, 720, 650));
  tap(image, 4, 380, 80);
  tap(image, 5, 200, 320);
  await waitFor(() => {
    expect(cdp.input).toStrictEqual(stroke(cdp.pageSession("floor"), 360, 360));
  });
});

test("browser-touch-regression-05 lifting a floor-plan contact after selecting elevation leaves only elevation's own tap", async () => {
  const { image, cdp } = await openPlans();
  const old = contact(31, 225, 675);
  fireEvent.pointerDown(image, { ...old, buttons: 1 });
  click(screen.getByLabelText("Elevation plan", { selector: '[role="tab"]' }));
  await expectStreamingAt(alternate);
  const next = screen.getByRole("img", { name: "Live browser view" });
  fireEvent.pointerUp(next, old);
  tap(next, 32, 720, 360);
  await waitFor(() => {
    expect(cdp.input).toStrictEqual(
      stroke(cdp.pageSession("elevation"), 720, 360),
    );
  });
});

test("browser-touch-regression-07 the desktop plan receives the click before the scroll at the wheel position", async () => {
  const { image, cdp } = await openPlans();
  const mouse = {
    pointerType: "mouse",
    pointerId: 1,
    clientX: 576,
    clientY: 540,
    button: 0,
    detail: 1,
  };
  fireEvent.pointerDown(image, { ...mouse, buttons: 1 });
  fireEvent.mouseDown(image, { ...mouse, buttons: 1 });
  fireEvent.pointerUp(image, { ...mouse, buttons: 0 });
  fireEvent.mouseUp(image, { ...mouse, buttons: 0 });
  // Happy DOM's WheelEvent extends UIEvent, so supply the native mouse coordinates.
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 96,
  });
  fireEvent(
    image,
    Object.assign(wheel, { clientX: 720, clientY: 450, buttons: 0 }),
  );
  const sessionId = cdp.pageSession("floor");
  await waitFor(() => {
    expect(cdp.input).toStrictEqual([
      ...stroke(sessionId, 576, 540),
      {
        method: "Input.dispatchMouseEvent",
        sessionId,
        params: expect.objectContaining({
          type: "mouseWheel",
          x: 720,
          y: 450,
          deltaY: 96,
        }),
      },
    ]);
  });
});
