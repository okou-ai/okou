import { screen, waitFor, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
import userEvent from "@testing-library/user-event";
import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";
import { mockMonotonicNow } from "../../../lib/time.ts";

const context = testContext();

test("browser-frame-budgets-01.01 displays the boundary-sized first image on the shared connection", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  const image = cdp.holdTargetFrames("example-page");
  await openPage();
  await image.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(screen.queryByRole("img", { name: "Live browser view" })).toBeNull();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  image.release("A".repeat(48 * 1024 * 1024));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});
test("browser-frame-budgets-03 recovers usable input after a transport message exceeds its envelope", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  const input = await screen.findByLabelText("Remote browser input");
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  cdp.event("Runtime.consoleAPICalled", {
    payload: "x".repeat(49 * 1024 * 1024),
  });
  await screen.findByText("Browser disconnected");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(await screen.findByText("Reconnect", { selector: "button" }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

const example = Object.freeze({
  targetId: "example-page",
  title: "Example",
  url: "https://example.com",
  windowId: 101,
});
const other = Object.freeze({
  targetId: "other",
  title: "Other",
  url: "https://other.example.test",
  windowId: 101,
});
function settings() {
  return screen.getByLabelText("Browser settings");
}
async function toggleFPS(value: "On" | "Off") {
  click(settings());
  await userEvent.hover(
    await screen.findByText("FPS", { selector: '[role="menuitem"]' }),
  );
  click(await screen.findByText(value));
}
test("browser-frame-rate-002 Keyboard selection opens the FPS display and restores toolbar focus", async () => {
  const { openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(example.url);
  await userEvent.click(settings());
  await userEvent.keyboard("f");
  await waitFor(() => {
    return expect(
      screen.getByText("FPS", { selector: '[role="menuitem"]' }),
    ).toHaveFocus();
  });
  await userEvent.keyboard("{ArrowRight}");
  await screen.findByText("Off");
  await userEvent.keyboard("{End}{Enter}");
  await screen.findByLabelText("— FPS");
  expect(settings()).toHaveFocus();
});
async function paintNine(
  cdp: ReturnType<typeof arrangeNativePage>["cdp"],
  advance: (ms: number) => void,
) {
  advance(100);
  for (let index = 0; index < 9; index++) {
    const previous = cdp.canvas.imageDraws.at(-1);
    cdp.frame("AAAA", cdp.pageSession(example.targetId));
    await waitFor(() => {
      return expect(cdp.canvas.imageDraws.at(-1)).not.toBe(previous);
    });
  }
  advance(900);
  await screen.findByLabelText("9 FPS");
}
test("browser-frame-rate-004 Choosing On again keeps the original one-second sample", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(example.url);
  await toggleFPS("On");
  await screen.findByLabelText("— FPS");
  advance(300);
  await toggleFPS("On");
  for (let index = 0; index < 9; index++) {
    const previous = cdp.canvas.imageDraws.at(-1);
    cdp.frame("AAAA", cdp.pageSession(example.targetId));
    await waitFor(() => {
      return expect(cdp.canvas.imageDraws.at(-1)).not.toBe(previous);
    });
  }
  advance(700);
  await screen.findByLabelText("9 FPS");
});
test("browser-frame-rate-010 PNG capture starts an empty FPS chart and then samples zero", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(example.url);
  await toggleFPS("On");
  await paintNine(cdp, advance);
  click(settings());
  await userEvent.hover(await screen.findByText("Image format"));
  click(await screen.findByText("PNG"));
  await expectStreamingAt(example.url);
  const cleared = await screen.findByLabelText("— FPS");
  expect(cleared.querySelector("path")).toBeNull();
  advance(1001);
  await screen.findByLabelText("0 FPS");
});
test("browser-frame-rate-011 Tab selection resets samples and reopening FPS discards the old chart", async () => {
  const advance = browserRecoveryClock(context.signal);
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [example, other],
  });
  await openPage();
  await expectStreamingAt(example.url);
  await toggleFPS("On");
  await paintNine(cdp, advance);
  for (const page of [other, example]) {
    click(screen.getByLabelText(page.title, { selector: '[role="tab"]' }));
    await expectStreamingAt(page.url);
    expect(screen.getByLabelText("— FPS").querySelector("path")).toBeNull();
  }
  advance(2000);
  await screen.findByLabelText("0 FPS");
  await toggleFPS("Off");
  expect(screen.queryByLabelText("0 FPS")).toBeNull();
  advance(5000);
  await toggleFPS("On");
  expect(
    (await screen.findByLabelText("— FPS")).querySelector("path"),
  ).toBeNull();
});
test("browser-frame-rate-003 Resizing a letterboxed image moves its FPS overlay to the image origin", async () => {
  const { openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(example.url);
  const canvas = screen.getByLabelText("Live browser view");
  const bounds = vi
    .spyOn(canvas, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 1600, 900));
  await toggleFPS("On");
  const overlay = (await screen.findByLabelText("— FPS")).querySelector(
    "foreignObject",
  );
  expect(overlay).toHaveAttribute("x", "80");
  expect(overlay).toHaveAttribute("y", "0");
  bounds.mockReturnValue(new DOMRect(0, 0, 800, 1000));
  window.dispatchEvent(new Event("resize"));
  await waitFor(() => {
    return expect(overlay).toHaveAttribute("y", "250");
  });
  expect(overlay).toHaveAttribute("x", "0");
});

test("browser-frame-rate-001 The browser settings radio reflects the 128-by-48 FPS overlay and regains focus on Escape", async () => {
  const { openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(example.url);
  expect(screen.queryByLabelText(/ FPS$/)).toBeNull();
  async function openRates() {
    await userEvent.click(settings());
    const row = await screen.findByText("FPS", {
      selector: '[role="menuitem"]',
    });
    await userEvent.hover(row);
    return (await screen.findByText("Off")).closest<HTMLElement>(
      '[role="menuitemradio"]',
    )!;
  }
  const initial = await openRates();
  expect(initial).toBeChecked();
  expect(initial.closest("[data-side]")).toHaveAttribute("data-side", "left");
  await userEvent.click(screen.getByText("On"));
  const chart = (await screen.findByLabelText("— FPS")).querySelector(
    "foreignObject",
  );
  expect(chart).toHaveAttribute("width", "128");
  expect(chart).toHaveAttribute("height", "48");
  const off = await openRates();
  expect(
    screen.getByText("On").closest('[role="menuitemradio"]'),
  ).toBeChecked();
  await userEvent.click(off);
  await waitFor(() => {
    expect(screen.queryByLabelText(/ FPS$/)).toBeNull();
  });
  await expect(openRates()).resolves.toBeChecked();
  await userEvent.keyboard("{Escape}{Escape}");
  await waitFor(() => {
    expect(settings()).toHaveFocus();
  });
});

test("The frame-rate display can be changed while remote text entry awaits its receipt", async () => {
  const { openPage, cdp } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(example.url);
  const held = cdp.holdNext("Input.insertText");
  const field = screen.getByLabelText("Remote browser input");
  await userEvent.click(field);
  fireEvent.input(field, {
    target: { value: "Harbor" },
    inputType: "insertText",
    data: "Harbor",
  });
  await held.received;
  try {
    await toggleFPS("On");
    await expect(screen.findByLabelText(/ FPS$/)).resolves.toBeInTheDocument();
    await toggleFPS("Off");
    await waitFor(() => {
      return expect(screen.queryByLabelText(/ FPS$/)).toBeNull();
    });
    expect(screen.getByLabelText("Address")).toHaveValue(example.url);
  } finally {
    await held.release();
  }
  expect(field).toBeEnabled();
});

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
