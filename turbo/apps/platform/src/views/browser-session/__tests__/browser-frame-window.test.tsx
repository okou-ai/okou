import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { mockMonotonicNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
type BrowserPeer = ReturnType<typeof arrangeNativePage>["cdp"];

// Each delivered image has a different native raster width. The live canvas
// adopts that width only when the production renderer paints its bitmap.
async function paintedRasters(peer: BrowserPeer, widths: readonly number[]) {
  const live = screen.getByRole("img", { name: "Live browser view" });
  const displayed = [];
  peer.holdFrameAcks();
  for (const width of widths) {
    if (!peer.frame("AAEC", undefined, width)) {
      continue;
    }
    await waitFor(() => {
      expect(live).toHaveAttribute("width", String(width));
    });
    displayed.push(Number(live.getAttribute("width")));
  }
  return displayed;
}

test("browser-frame-window-01.01 three short probe samples admit three distinct live images", async () => {
  let elapsed = 0;
  const samples = [1, 2, 3];
  const sampled = context.mocks.deferred<void>();
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  const { cdp, openPage } = arrangeNativePage(context, {
    enforceFrameWindow: true,
    onVersionProbe: () => {
      const sample = samples.shift();
      if (sample !== undefined) {
        elapsed += sample;
        if (!samples.length) {
          sampled.resolve();
        }
      }
    },
  });
  const first = cdp.holdTargetFrames("example-page");
  await openPage();
  await sampled.promise;
  await first.received;
  first.release();
  await expectStreamingAt("https://example.com");

  await expect(
    paintedRasters(cdp, [960, 980, 1000, 1020]),
  ).resolves.toStrictEqual([960, 980, 1000]);
});

test.each([
  { id: "02", probe: "pending" },
  { id: "03", probe: "rejected" },
])(
  "browser-frame-window-$id paints three frames and accepts input with the optional probe $probe",
  async ({ probe }) => {
    const { cdp, openPage } = arrangeNativePage(context, {
      enforceFrameWindow: true,
    });
    const held = cdp.holdNext("Browser.getVersion");
    if (probe === "rejected") {
      cdp.failNext("Browser.getVersion", "Optional measurement unavailable");
    }
    const first = cdp.holdTargetFrames("example-page");
    await openPage();
    await held.received;
    if (probe === "rejected") {
      await held.release();
    }
    await first.received;
    first.release();
    await expectStreamingAt("https://example.com");
    const input = screen.getByLabelText("Remote browser input");
    input.focus();
    fireEvent.input(input, {
      inputType: "insertText",
      data: probe,
      target: { value: probe },
    });
    await waitFor(() => {
      expect(cdp.input).toContainEqual({
        sessionId: cdp.pageSession("example-page"),
        method: "Input.insertText",
        params: { text: probe },
      });
    });
    await expect(
      paintedRasters(cdp, [960, 980, 1000, 1020]),
    ).resolves.toStrictEqual([960, 980, 1000]);
  },
);

test("browser-frame-window-05 a delayed shared-socket reply leaves the separate image path at eight frames", async () => {
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  const { cdp, openPage } = arrangeNativePage(context, {
    enforceFrameWindow: true,
    onVersionProbe: () => {
      elapsed += 200;
    },
  });
  const shared = cdp.holdNext("Browser.getVersion");
  await openPage();
  await shared.received;
  await expectStreamingAt("https://example.com");
  const splitFrame = cdp.holdTargetFrames("example-page");
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  click(await screen.findByText("Separate image connection"));
  await splitFrame.received;
  splitFrame.release();
  await expectStreamingAt("https://example.com");
  await shared.release();
  const widths = [900, 928, 944, 960, 992, 1008, 1024, 1080, 1104];
  await expect(paintedRasters(cdp, widths)).resolves.toStrictEqual(
    widths.slice(0, 8),
  );
});
