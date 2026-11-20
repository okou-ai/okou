import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import type { mockBrowserCdp } from "../../../__tests__/browser-cdp-fixture.ts";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { mockMonotonicNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
type Browser = ReturnType<typeof mockBrowserCdp>;

async function expectPaintWindow(cdp: Browser, frames: number) {
  expect(cdp.captures.at(-1)).toMatchObject({ maxFramesInFlight: frames });
  const firstDraw = cdp.canvas.imageDraws.length;
  for (let index = 1; index < frames; index++) {
    cdp.frame("AAAA");
    await waitFor(() => {
      expect(cdp.canvas.imageDraws).toHaveLength(firstDraw + index);
    });
  }
}

test("Three short RTT samples yield a three-frame painted window", async () => {
  let time = 0;
  const samples = [1, 2, 3];
  const measured: number[] = [];
  mockMonotonicNow(() => {
    return time;
  }, context.signal);
  const { cdp, openPage } = arrangeNativePage(context, {
    enforceFrameWindow: true,
    onVersionProbe() {
      const duration = samples.shift();
      if (duration !== undefined) {
        time += duration;
        measured.push(duration);
      }
    },
  });
  cdp.holdFrameAcks();
  const firstFrame = cdp.holdFrames("target:example-page");
  await openPage();
  await firstFrame.received;
  expect(measured).toStrictEqual([1, 2, 3]);
  firstFrame.release();

  await expectStreamingAt("https://example.com");
  await expectPaintWindow(cdp, 3);
});

test("Keep the three-frame window while the optional RTT probe is stalled", async () => {
  const { cdp, openPage } = arrangeNativePage(context, {
    enforceFrameWindow: true,
  });
  const probe = cdp.holdNext("Browser.getVersion");
  cdp.holdFrameAcks();
  await openPage();
  await probe.received;

  await expectStreamingAt("https://example.com");
  expect(
    cdp.requests.filter((request) => {
      return request.method === "Browser.getVersion";
    }),
  ).toHaveLength(1);
  await expectPaintWindow(cdp, 3);
});

test("Keep the three-frame window when the optional RTT probe is rejected", async () => {
  const { cdp, openPage } = arrangeNativePage(context, {
    enforceFrameWindow: true,
  });
  cdp.failNext("Browser.getVersion", "Version probe unavailable");
  cdp.holdFrameAcks();
  await openPage();

  await expectStreamingAt("https://example.com");
  expect(
    cdp.requests.filter((request) => {
      return request.method === "Browser.getVersion";
    }),
  ).toHaveLength(1);
  await expectPaintWindow(cdp, 3);
});

test("Size the split image socket from its own RTT after retiring the shared probe", async () => {
  let time = 0;
  let measureSplit = false;
  const measured: number[] = [];
  mockMonotonicNow(() => {
    return time;
  }, context.signal);
  const { cdp, openPage } = arrangeNativePage(context, {
    enforceFrameWindow: true,
    onVersionProbe(connectionId) {
      if (measureSplit) {
        time += 200;
        measured.push(connectionId);
      }
    },
  });
  const shared = cdp.holdNext("Browser.getVersion");
  await openPage();
  await shared.received;
  await expectStreamingAt("https://example.com");
  const sharedSocket = cdp.requests.find((request) => {
    return request.method === "Browser.getVersion";
  })?.connectionId;
  expect(cdp.captures.at(-1)).toMatchObject({ maxFramesInFlight: 3 });

  cdp.holdFrameAcks();
  measureSplit = true;
  const splitFrame = cdp.holdFrames("target:example-page");
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  const separate = await waitFor(() => {
    const option = queryAllByRoleFast("menuitemradio").find((item) => {
      return item.textContent?.trim() === "Separate image connection";
    });
    if (!option) {
      throw new Error("Separate image connection option was not available");
    }
    return option;
  });
  click(separate);
  await splitFrame.received;
  expect(measured).toHaveLength(3);
  expect(new Set(measured).size).toBe(1);
  expect(measured[0]).not.toBe(sharedSocket);
  await shared.release();
  const drawsBeforeSplitFrame = cdp.canvas.imageDraws.length;
  splitFrame.release();
  await waitFor(() => {
    expect(cdp.canvas.imageDraws.length).toBeGreaterThan(drawsBeforeSplitFrame);
  });

  await expectStreamingAt("https://example.com");
  await expectPaintWindow(cdp, 8);
});
