import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";

import { act, screen, waitFor, within } from "@testing-library/react";
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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const operationError =
  "The browser action could not be completed. Check the browser before trying again.";

function mockViewer(
  canvasBox: () => DOMRect = () => {
    return new DOMRect(0, 0, 900, 600);
  },
) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this instanceof HTMLCanvasElement
        ? canvasBox()
        : original.call(this);
    },
  );
  const session: BrowserSession = {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 0,
    },
  };
  const cdpUrl = "wss://browser.example/display-regressions";
  const browser = mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: session,
      viewer: { browser: session, cdpUrl, extension: TEST_BROWSER_EXTENSION },
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: session,
      viewer: {
        browser: session,
        cdpUrl,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  return browser;
}

async function openViewer() {
  await setupPage({
    context,
    path: `/browsers/${threadId}`,
  });
  return screen.findByRole("region", { name: "Remote browser viewer" });
}

function observeFailures(viewer: HTMLElement) {
  const failures: string[] = [];
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const nodes =
        mutation.type === "characterData"
          ? [mutation.target]
          : mutation.addedNodes;
      for (const node of nodes) {
        const text = node.textContent ?? "";
        if (
          text.includes("Browser view unavailable") ||
          text.includes("Browser disconnected")
        ) {
          failures.push(text);
        }
      }
    }
  });
  observer.observe(viewer, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
    },
    { once: true },
  );
  return failures;
}

async function openWindowSizeMenu(viewer: HTMLElement) {
  click(within(viewer).getByLabelText("Browser settings"));
  const settings = await screen.findByRole("menu", {
    name: "Browser settings",
  });
  click(within(settings).getByText("Window size"));
  return screen.findByRole("menu", { name: "Window size" });
}

function sizeOption(menu: HTMLElement, name: string) {
  const option = [
    ...queryAllByRoleFast("menuitemradio", menu),
    ...queryAllByRoleFast("menuitem", menu),
  ].find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!option) {
    throw new Error(`Missing window size option: ${name}`);
  }
  return option;
}

test("A minimized remote window is restored and fitted without user action", async () => {
  const state = "minimized";
  const browser = mockViewer();
  browser.targets.push({
    targetId: "foreign-page",
    title: "Foreign",
    url: "https://foreign.example.com",
    windowId: 1,
  });
  browser.setWindowState(state);
  browser.setWindowState("fullscreen", 1);

  const viewer = await openViewer();

  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(browser.windowState()).toBe("normal");
  expect(browser.windowState(1)).toBe("fullscreen");
  expect(within(viewer).queryByRole("alert")).not.toBeInTheDocument();
  expect(
    browser.requests
      .filter((request) => {
        return request.method === "Browser.setWindowBounds";
      })
      .map((request) => {
        return request.params;
      }),
  ).toStrictEqual([{ windowId: 0, bounds: { windowState: "normal" } }]);
});

test("Restoring an already calibrated window waits for a fresh native frame", async () => {
  const browser = mockViewer();
  const viewer = await openViewer();
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  act(() => {
    browser.frame("AAAA");
  });
  browser.setWindowState("maximized", 0, { width: 1280, height: 720 });
  const frames = browser.holdFrames("example-page-session");
  const sizing = await openWindowSizeMenu(viewer);

  click(sizeOption(sizing, "Fit window to panel"));
  await frames.received;

  expect(browser.windowState()).toBe("normal");
  expect(browser.viewport).toStrictEqual({ width: 1280, height: 720 });
  await waitFor(() => {
    expect(sizing).not.toBeInTheDocument();
  });
  const pendingSizing = await openWindowSizeMenu(viewer);
  expect(sizeOption(pendingSizing, "Fit window to panel")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  act(() => {
    frames.release();
  });
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(within(viewer).queryByRole("alert")).not.toBeInTheDocument();
});

test("A minimized window can be synchronized again after native capture preparation fails", async () => {
  const browser = mockViewer();
  browser.setWindowState("maximized");
  const restoring = browser.holdNext("Browser.setWindowBounds");
  const viewer = await openViewer();
  await restoring.received;
  browser.failNext("Page.stopScreencast", "The capture could not be stopped");
  await act(async () => {
    await restoring.release();
  });
  await expect(within(viewer).findByRole("alert")).resolves.toHaveTextContent(
    operationError,
  );
  browser.setWindowState("minimized");
  const sizing = await openWindowSizeMenu(viewer);

  click(sizeOption(sizing, "Fit window to panel"));

  await waitFor(() => {
    expect(browser.windowState()).toBe("normal");
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(within(viewer).queryByRole("alert")).not.toBeInTheDocument();
});

test("A minimized window is restored after its pending calibration frame is invalidated", async () => {
  const browser = mockViewer();
  const viewer = await openViewer();
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  act(() => {
    browser.frame("AAAA");
  });
  browser.setWindowState("maximized", 0, { width: 1280, height: 720 });
  const frames = browser.holdFrames("example-page-session");
  const sizing = await openWindowSizeMenu(viewer);
  click(sizeOption(sizing, "Fit window to panel"));
  await frames.received;
  const observation = browser.holdNext("Browser.getWindowForTarget");
  act(() => {
    frames.release();
  });
  await observation.received;

  act(() => {
    browser.event("Page.frameResized", {}, "example-page-session");
    browser.setWindowState("minimized");
  });
  await act(async () => {
    await observation.release();
  });

  await waitFor(() => {
    expect(browser.windowState()).toBe("normal");
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(within(viewer).queryByRole("alert")).not.toBeInTheDocument();
});

test("A target moved during restoration cannot authorize further display writes", async () => {
  const browser = mockViewer();
  browser.targets.push({
    targetId: "foreign-page",
    title: "Foreign",
    url: "https://foreign.example.com",
    windowId: 1,
  });
  const viewer = await openViewer();
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  act(() => {
    browser.frame("AAAA");
  });
  browser.setWindowState("maximized");
  browser.setWindowState("fullscreen", 1);
  const restoring = browser.holdNext("Browser.setWindowBounds");
  const sizing = await openWindowSizeMenu(viewer);
  click(sizeOption(sizing, "Fit window to panel"));
  await restoring.received;

  act(() => {
    browser.move("example-page", 1);
  });
  await waitFor(() => {
    expect(
      within(viewer).getByLabelText("Remote browser input"),
    ).toBeDisabled();
  });
  await act(async () => {
    await restoring.release();
  });

  await expect(
    within(viewer).findByText("No tabs open"),
  ).resolves.toBeInTheDocument();
  expect(browser.windowState(1)).toBe("fullscreen");
  expect(
    browser.requests.filter((request) => {
      return request.method === "Emulation.clearDeviceMetricsOverride";
    }),
  ).toStrictEqual([]);
});

test("Display synchronization resumes after image recovery with the frame first", async () => {
  const browser = mockViewer();
  const viewer = await openViewer();
  const input = within(viewer).getByLabelText("Remote browser input");
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(input).toBeEnabled();
  });
  const capture = browser.holdNext("Page.startScreencast");
  act(() => {
    browser.frame("!");
  });
  await screen.findByText("Reconnecting…");
  const frame = browser.holdTargetFrames("example-page");
  await capture.received;
  await frame.received;
  act(() => {
    frame.release();
  });
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  await act(async () => {
    await capture.release();
  });
  await waitFor(() => {
    expect(input).toBeEnabled();
  });

  // A panel resize could restart capture and conceal a suspended display.
  browser.setWindowState("maximized", 0, {
    width: 1280,
    height: 720,
  });
  const sizing = await openWindowSizeMenu(viewer);
  click(sizeOption(sizing, "Fit window to panel"));
  await waitFor(() => {
    expect(browser.windowState()).toBe("normal");
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(input).toBeEnabled();
  });
});

test("A window resize keeps the accepted picture while capture is pending", async () => {
  let canvasBox = new DOMRect(0, 0, 900, 600);
  const browser = mockViewer(() => {
    return canvasBox;
  });
  const viewer = await openViewer();
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  act(() => {
    browser.frame("AAAA");
  });

  const failures = observeFailures(viewer);
  const frame = browser.holdTargetFrames("example-page");
  canvasBox = new DOMRect(0, 0, 720, 480);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  await frame.received;
  expect(within(viewer).getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    within(viewer).queryByText("Browser view unavailable"),
  ).not.toBeInTheDocument();
  expect(
    within(viewer).getByRole("img", { name: "Live browser view" }),
  ).toBeInTheDocument();
  act(() => {
    frame.release();
  });
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 720, height: 480 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    browser.requests.filter((request) => {
      return request.method === "Browser.setWindowBounds";
    }),
  ).toStrictEqual([]);
  expect(failures).toStrictEqual([]);
});

test("Returning to a visible viewer does not flash a failure during display setup", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = mockViewer();
  const viewer = await openViewer();
  const input = within(viewer).getByLabelText("Remote browser input");
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  const failures = observeFailures(viewer);
  act(() => {
    visibility.changeTo("hidden");
  });
  await within(viewer).findByText("Viewing paused");
  expect(input).toBeDisabled();
  act(() => {
    visibility.changeTo("visible");
  });
  await waitFor(() => {
    expect(input).toBeEnabled();
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
  });
  expect(
    within(viewer).getByRole("img", { name: "Live browser view" }),
  ).toBeInTheDocument();
  expect(failures).toStrictEqual([]);
});
