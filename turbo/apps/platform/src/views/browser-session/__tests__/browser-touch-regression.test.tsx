import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const home = "https://example.com";

async function openPointerViewer(twoTabs = false) {
  const { cdp, openPage } = arrangeNativePage(
    context,
    twoTabs
      ? {
          targets: [
            {
              targetId: "example-page",
              title: "Example",
              url: home,
              windowId: 101,
            },
            {
              targetId: "other-page",
              title: "Other",
              url: "https://other.example",
              windowId: 101,
            },
          ],
        }
      : {},
  );
  await openPage();
  await expectStreamingAt(home);
  const canvas = screen.getByRole("img", { name: "Live browser view" });
  const surface = canvas.closest("[data-browser-surface]");
  if (!(surface instanceof HTMLElement)) {
    throw new Error("Missing browser pointer surface");
  }
  const box = vi
    .spyOn(canvas, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 1440, 900));
  return { cdp, surface, box };
}

function pointer(x: number, y: number, pointerId = 1, pointerType = "touch") {
  return {
    clientX: x,
    clientY: y,
    pointerId,
    pointerType,
    isPrimary: true,
    button: 0,
  };
}

function tap(surface: HTMLElement, x: number, y: number, id = 1) {
  fireEvent.pointerDown(surface, { ...pointer(x, y, id), buttons: 1 });
  fireEvent.pointerUp(surface, { ...pointer(x, y, id), buttons: 0 });
}

const clickAt = (x: number, y: number) => {
  return [
    expect.objectContaining({
      method: "Input.dispatchMouseEvent",
      params: expect.objectContaining({ type: "mousePressed", x, y }),
    }),
    expect.objectContaining({
      method: "Input.dispatchMouseEvent",
      params: expect.objectContaining({ type: "mouseReleased", x, y }),
    }),
  ];
};

test("Send one touch click at the release point despite compatibility mouse events", async () => {
  const { cdp, surface } = await openPointerViewer();
  fireEvent.pointerDown(surface, { ...pointer(120, 150), buttons: 1 });
  fireEvent.pointerMove(surface, { ...pointer(122, 152), buttons: 1 });
  fireEvent.pointerUp(surface, { ...pointer(124, 153), buttons: 0 });
  fireEvent.mouseDown(surface, {
    clientX: 124,
    clientY: 153,
    button: 0,
    buttons: 1,
  });
  fireEvent.mouseUp(surface, {
    clientX: 124,
    clientY: 153,
    button: 0,
    buttons: 0,
  });

  await waitFor(() => {
    expect(cdp.input).toStrictEqual(clickAt(124, 153));
    expect(screen.getByLabelText("Remote browser input")).toHaveFocus();
  });
});

test("Pointer cancellation drops the active gesture and leaves the next tap usable", async () => {
  const { cdp, surface } = await openPointerViewer();
  fireEvent.pointerDown(surface, { ...pointer(120, 150), buttons: 1 });
  fireEvent.pointerCancel(surface, pointer(120, 150));
  fireEvent.pointerUp(surface, { ...pointer(120, 150), buttons: 0 });

  tap(surface, 300, 400, 2);

  await waitFor(() => {
    expect(cdp.input).toStrictEqual(clickAt(300, 400));
  });
});

test("Ignore letterbox taps and map touches within the image", async () => {
  const { cdp, surface, box } = await openPointerViewer();
  box.mockReturnValue(new DOMRect(0, 0, 1600, 900));
  tap(surface, 40, 450);
  tap(surface, 800, 450, 2);

  await waitFor(() => {
    expect(cdp.input).toStrictEqual(clickAt(720, 450));
  });
});

test("Discard the old tab touch and send the new tap only to the selected tab", async () => {
  const { cdp, surface } = await openPointerViewer(true);
  fireEvent.pointerDown(surface, { ...pointer(120, 150), buttons: 1 });
  click(await screen.findByText("Other"));
  await expectStreamingAt("https://other.example");
  fireEvent.pointerUp(surface, { ...pointer(120, 150), buttons: 0 });

  tap(surface, 300, 400, 2);

  const session = cdp.pageSession("other-page");
  await waitFor(() => {
    expect(cdp.input).toStrictEqual(clickAt(300, 400));
    expect(
      cdp.input.every((item) => {
        return item.sessionId === session;
      }),
    ).toBeTruthy();
  });
});

test("Forward a desktop mouse click and wheel movement in order", async () => {
  const { cdp, surface } = await openPointerViewer();
  fireEvent.pointerDown(surface, {
    ...pointer(300, 400, 1, "mouse"),
    buttons: 1,
  });
  fireEvent.mouseDown(surface, {
    clientX: 300,
    clientY: 400,
    button: 0,
    buttons: 1,
  });
  fireEvent.mouseUp(surface, {
    clientX: 300,
    clientY: 400,
    button: 0,
    buttons: 0,
  });
  fireEvent.pointerUp(surface, {
    ...pointer(300, 400, 1, "mouse"),
    buttons: 0,
  });
  fireEvent.wheel(surface, {
    clientX: 300,
    clientY: 400,
    deltaX: 9,
    deltaY: 17,
  });

  await waitFor(() => {
    expect(cdp.input).toStrictEqual([
      ...clickAt(300, 400),
      expect.objectContaining({
        method: "Input.dispatchMouseEvent",
        params: expect.objectContaining({
          type: "mouseWheel",
          deltaX: 9,
          deltaY: 17,
        }),
      }),
    ]);
  });
});
