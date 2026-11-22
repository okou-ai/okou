import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
const context = testContext(),
  url = "https://example.com",
  target = "example-page";
async function fit() {
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Window size"));
  click(await screen.findByText("Fit window to panel"));
}
const input = () => {
  return screen.getByLabelText("Remote browser input");
};
test("browser-display-regression-013 Fitting a recovered image normalizes the primary window after a decoded frame precedes its capture receipt", async () => {
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 900, 600));
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(url);
  const reply = cdp.holdNext("Page.startScreencast"),
    frame = cdp.holdTargetFrames(target);
  vi.spyOn(globalThis, "createImageBitmap").mockRejectedValueOnce(
    new Error("Local unreadable picture"),
  );
  cdp.frame("AAAA", cdp.pageSession(target));
  await reply.received;
  await frame.received;
  frame.release();
  expect(input()).toBeDisabled();
  await reply.release();
  await expectStreamingAt(url);
  Object.assign(cdp.viewport, { width: 1280, height: 720 });
  cdp.setWindowState("maximized", 101, { width: 1280, height: 720 });
  await fit();
  await waitFor(() => {
    return expect(cdp.windowState(101)).toBe("normal");
  });
  await waitFor(() => {
    return expect(cdp.viewport).toStrictEqual({ width: 900, height: 600 });
  });
  await expectStreamingAt(url);
});
