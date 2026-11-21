import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
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
