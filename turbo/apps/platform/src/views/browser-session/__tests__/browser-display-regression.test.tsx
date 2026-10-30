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

function mockViewer() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this instanceof HTMLCanvasElement
        ? new DOMRect(0, 0, 900, 600)
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
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
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
  const option = queryAllByRoleFast("menuitemradio", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!option) {
    throw new Error(`Missing window size option: ${name}`);
  }
  return option;
}

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
