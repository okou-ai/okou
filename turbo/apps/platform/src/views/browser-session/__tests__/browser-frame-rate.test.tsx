import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";

import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockMonotonicNow, mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

async function viewer() {
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  mockNow(Date.parse("2026-09-01T10:00:00Z"), context.signal);
  const browser = mockBrowserCdp(context, "wss://browser.example/fps", {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 101,
      },
      {
        targetId: "other",
        title: "Other",
        url: "https://other.example",
        windowId: 101,
      },
    ],
  });
  const session: BrowserSession = {
    threadId,
    name: "FPS",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: null,
    screenshotUrl: null,
    timeoutMinutes: 10,
    idleExpiresAt: "2026-09-01T10:10:00Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 101,
    },
  };
  const connection = {
    browser: session,
    cdpUrl: "wss://browser.example/fps",
    extension: TEST_BROWSER_EXTENSION,
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: session, viewer: connection });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  await setupPage({
    context,
    path: `/browsers/${threadId}`,
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const canvas = screen.getByLabelText<HTMLCanvasElement>("Live browser view");
  const paint = vi.spyOn(canvas.getContext("2d")!, "drawImage");
  return {
    browser,
    paint,
    advance(ms: number) {
      act(() => {
        elapsed += ms;
      });
    },
    async frames(count: number) {
      const before = paint.mock.calls.length;
      for (let index = 0; index < count; index++) {
        await act(() => {
          browser.frame("AAAA");
          return Promise.resolve();
        });
      }
      await waitFor(() => {
        expect(paint).toHaveBeenCalledTimes(before + count);
      });
    },
  };
}

function item(
  role: "menuitem" | "menuitemradio" | "tab",
  name: string,
  container = document.body,
) {
  const found = queryAllByRoleFast(role, container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!found) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return found;
}

async function fpsMenu() {
  click(screen.getByLabelText("Browser settings"));
  const menu = await screen.findByRole("menu", { name: "Browser settings" });
  click(item("menuitem", "FPS", menu));
  return screen.findByRole("menu", { name: "FPS" });
}

async function enable() {
  click(item("menuitemradio", "On", await fpsMenu()));
  await screen.findByRole("img", { name: "— FPS" });
}

function chartLines() {
  return screen
    .getByRole("img", { name: / FPS$/ })
    .querySelectorAll('path[fill="none"]');
}

test("FPS is default Off and selected through a left-opening radio submenu", async () => {
  const { browser } = await viewer();
  expect(screen.queryByRole("img", { name: / FPS$/ })).not.toBeInTheDocument();
  const before = browser.requests.length;
  const menu = await fpsMenu();
  expect(item("menuitemradio", "Off", menu)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(menu).toHaveAttribute("data-side", "left");
  click(item("menuitemradio", "On", menu));
  const overlay = await screen.findByRole("img", { name: "— FPS" });
  expect(overlay.querySelector("foreignObject")).toHaveAttribute(
    "width",
    "128",
  );
  expect(overlay.querySelector("foreignObject")).toHaveAttribute(
    "height",
    "48",
  );
  expect(browser.requests.slice(before)).toStrictEqual([]);
  const selected = await fpsMenu();
  expect(item("menuitemradio", "On", selected)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  click(item("menuitemradio", "Off", selected));
  await waitFor(() => {
    expect(overlay).not.toBeInTheDocument();
  });
  const reopened = await fpsMenu();
  expect(item("menuitemradio", "Off", reopened)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await userEvent.keyboard("{Escape}{Escape}");
  await waitFor(() => {
    expect(screen.getByLabelText("Browser settings")).toHaveFocus();
  });
});

test("FPS can be enabled with keyboard menu navigation", async () => {
  await viewer();
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.keyboard("{End}{Enter}");
  await screen.findByRole("menu", { name: "FPS" });
  await userEvent.keyboard("{End}{Enter}");
  await expect(
    screen.findByRole("img", { name: "— FPS" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByLabelText("Browser settings")).toHaveFocus();
  });
});

test("The overlay follows the contained image origin when the viewer is resized", async () => {
  await viewer();
  click(screen.getByLabelText("Browser settings"));
  const settings = await screen.findByRole("menu", {
    name: "Browser settings",
  });
  click(item("menuitem", "Window size", settings));
  const sizing = await screen.findByRole("menu", { name: "Window size" });
  click(item("menuitemradio", "Off", sizing));
  await waitFor(() => {
    expect(sizing).not.toBeInTheDocument();
  });
  const canvas = screen.getByLabelText<HTMLCanvasElement>("Live browser view");
  const box = vi
    .spyOn(canvas, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 1600, 900));
  await enable();
  const overlay = screen
    .getByRole("img", { name: "— FPS" })
    .querySelector("foreignObject");
  expect(overlay).toHaveAttribute("x", "80");
  expect(overlay).toHaveAttribute("y", "0");
  box.mockReturnValue(new DOMRect(0, 0, 800, 1000));
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  await waitFor(() => {
    expect(overlay).toHaveAttribute("x", "0");
    expect(overlay).toHaveAttribute("y", "250");
  });
});

test("Choosing On again preserves the running counter", async () => {
  const v = await viewer();
  await enable();
  click(item("menuitemradio", "On", await fpsMenu()));
  v.advance(100);
  await v.frames(9);
  v.advance(900);
  await expect(
    screen.findByRole("img", { name: "9 FPS" }),
  ).resolves.toBeInTheDocument();
});

test("Changing capture settings starts a fresh measurement window", async () => {
  const v = await viewer();
  await enable();
  v.advance(100);
  await v.frames(9);
  v.advance(900);
  await screen.findByRole("img", { name: "9 FPS" });
  click(screen.getByLabelText("Browser settings"));
  const settings = await screen.findByRole("menu", {
    name: "Browser settings",
  });
  click(item("menuitem", "Image format", settings));
  const formats = await screen.findByRole("menu", { name: "Image format" });
  click(item("menuitemradio", "PNG", formats));
  await screen.findByRole("img", { name: "— FPS" });
  expect(chartLines()).toHaveLength(0);
  v.advance(1000);
  await screen.findByRole("img", { name: "0 FPS" });
});

test("Selecting another tab resets its reading and history; disabling discards collected paints", async () => {
  const v = await viewer();
  await enable();
  v.advance(100);
  await v.frames(9);
  v.advance(900);
  await screen.findByRole("img", { name: "9 FPS" });
  click(item("tab", "Other"));
  await screen.findByRole("img", { name: "— FPS" });
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example",
    );
  });
  expect(chartLines()).toHaveLength(0);
  click(item("tab", "Example"));
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByRole("img", { name: "— FPS" })).toBeInTheDocument();
  expect(chartLines()).toHaveLength(0);
  v.advance(2000);
  await waitFor(() => {
    expect(screen.getByRole("img", { name: "0 FPS" })).toBeInTheDocument();
  });
  click(item("menuitemradio", "Off", await fpsMenu()));
  expect(screen.queryByRole("img", { name: / FPS$/ })).not.toBeInTheDocument();
  v.advance(5000);
  await enable();
  expect(chartLines()).toHaveLength(0);
});
