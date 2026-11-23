import { act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserTab,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
import {
  scopedViewer,
  firstUrl,
  input,
} from "./scoped-browser-transport-fixtures.ts";
const context = testContext();
test("browser-frames-recovery-009 A lost image connection during retry can still deliver a fresh image of Example", async () => {
  const advance = browserRecoveryClock(context.signal);
  const v = scopedViewer(context);
  await v.start(true);
  const cdp = v.cdp;
  vi.spyOn(globalThis, "createImageBitmap").mockRejectedValueOnce(
    new Error("Invalid raster from image transport"),
  );
  const session = cdp.requests
    .filter((r) => {
      return r.method === "Page.startScreencast";
    })
    .at(-1)!.sessionId!;
  const capture = cdp.holdNext("Page.startScreencast");
  expect(cdp.frame("AQID", session)).toBeTruthy();
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  advance(1000);
  await capture.received;
  const fresh = cdp.holdTargetFrames(v.first);
  await act(async () => {
    v.disconnectImage();
    await capture.release();
  });
  advance(2000);
  await fresh.received;
  expect(input()).toBeDisabled();
  expect(browserTab("Example")).toHaveAttribute("aria-selected", "true");
  fresh.release();
  await expectStreamingAt(firstUrl);
  expect(browserTab("Example")).toHaveAttribute("aria-selected", "true");
  await waitFor(() => {
    return expect(screen.queryByText(/retry live image/i)).toBeNull();
  });
});
