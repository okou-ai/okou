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
    proxyCountryCode: null,
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
    return respond(200, { browser: session });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, {
      browser: session,
      cdpUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  return browser;
}

async function openViewer() {
  await setupPage({ context, path: `/browsers/${threadId}` });
  return screen.findByRole("region", { name: "Remote browser viewer" });
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

test.each(["minimized", "maximized", "fullscreen"])(
  "A %s remote window is restored and fitted without user action",
  async (state) => {
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
      expect(
        within(viewer).getByLabelText("Remote browser input"),
      ).toBeEnabled();
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
  },
);

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

test.each(["rejected", "ineffective"])(
  "A %s native restoration remains a failure after one attempt",
  async (failure) => {
    const browser = mockViewer();
    browser.setWindowState("maximized");
    if (failure === "rejected") {
      browser.failNext("Browser.setWindowBounds", "Native restoration failed");
    } else {
      browser.ignoreNextWindowRestore();
    }

    const viewer = await openViewer();

    const alert = await within(viewer).findByRole("alert");
    expect(alert).toHaveTextContent(operationError);
    expect(browser.windowState()).toBe("maximized");
    expect(
      browser.requests.filter((request) => {
        return request.method === "Browser.setWindowBounds";
      }),
    ).toHaveLength(1);
  },
);

test("An unknown native state fails without being normalized", async () => {
  const browser = mockViewer();
  browser.setWindowState("unknown");

  const viewer = await openViewer();

  const alert = await within(viewer).findByRole("alert");
  expect(alert).toHaveTextContent(operationError);
  expect(browser.windowState()).toBe("unknown");
});

test("A size-mode synchronization failure is reported rather than treated as success", async () => {
  const browser = mockViewer();
  const viewer = await openViewer();
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  // A successful resize is followed by a screencast frame from the native browser.
  // The fixture only emits frames when capture starts; supply the resized image.
  act(() => {
    browser.frame("AAAA");
  });
  const sizing = await openWindowSizeMenu(viewer);
  click(sizeOption(sizing, "Off"));
  await waitFor(() => {
    expect(sizing).not.toBeInTheDocument();
  });
  const disabledSizing = await openWindowSizeMenu(viewer);
  const onConnection = sizeOption(disabledSizing, "On connection");
  await waitFor(() => {
    expect(sizeOption(disabledSizing, "Off")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(onConnection).not.toHaveAttribute("aria-disabled", "true");
  });
  browser.failNext(
    "Page.getLayoutMetrics",
    "The native display metrics are unavailable",
  );
  const sync = browser.holdNext("Page.getLayoutMetrics");
  click(onConnection);
  await waitFor(() => {
    expect(disabledSizing).not.toBeInTheDocument();
  });
  await sync.received;

  await act(async () => {
    await sync.release();
  });
  const alerts = await within(viewer).findAllByRole("alert");
  expect(alerts[0]).toHaveTextContent(operationError);
  const failedSizing = await openWindowSizeMenu(viewer);
  expect(sizeOption(failedSizing, "On connection")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(sizeOption(failedSizing, "Off")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Automatic panel sizing exposes a native display failure without a settings action", async () => {
  const browser = mockViewer();
  browser.failNext(
    "Emulation.setDeviceMetricsOverride",
    "The display could not be resized",
  );
  const viewer = await openViewer();
  const alerts = await within(viewer).findAllByRole("alert");
  expect(alerts[0]).toHaveTextContent(operationError);
  expect(within(viewer).getByLabelText("Address")).toHaveValue(
    "https://example.com",
  );
  expect(within(viewer).getByLabelText("Browser settings")).toBeEnabled();
});

test("A window resize synchronizes the remote display to the new panel size", async () => {
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

  canvasBox = new DOMRect(0, 0, 720, 480);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 720, height: 480 });
  });
  expect(
    browser.requests.filter((request) => {
      return request.method === "Browser.setWindowBounds";
    }),
  ).toStrictEqual([]);
});
