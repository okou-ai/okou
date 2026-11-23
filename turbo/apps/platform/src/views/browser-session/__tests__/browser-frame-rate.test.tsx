import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
const context = testContext();
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

test("The browser settings radio reflects the 128-by-48 FPS overlay and regains focus on Escape", async () => {
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
  await userEvent.click(
    screen.getByText("On").closest('[role="menuitemradio"]'),
  );
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
