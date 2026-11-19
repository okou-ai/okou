import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openQualityInput } from "./browser-settings-test-helpers.ts";

import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/frames-recovery";

async function inputReady() {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

async function setupSplitViewer() {
  const advanceRecovery = browserRecoveryClock(context.signal);
  const browser = mockBrowserCdp(context, endpoint, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 0,
      },
      {
        targetId: "other-page",
        title: "Other",
        url: "https://other.example",
        windowId: 0,
      },
      {
        targetId: "sibling-page",
        title: "Sibling",
        url: "https://sibling.example",
        windowId: 1,
      },
    ],
  });
  const session: BrowserSession = {
    threadId,
    name: "frames recovery",
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
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: session,
      viewer: {
        browser: session,
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await inputReady();
  const sharedSession = browser.pageSession("example-page");
  click(screen.getByLabelText("Browser settings"));
  const settings = await screen.findByRole("menu", {
    name: "Browser settings",
  });
  click(within(settings).getByText("Connection mode"));
  const mode = await screen.findByRole("menu", { name: "Connection mode" });
  click(within(mode).getByText("Separate image connection"));
  // The old input can still look ready before the async transport rebuild.
  // Observe the replacement transport before injecting any capture failure.
  await waitFor(() => {
    expect(browser.connections()).toBe(3);
    expect(browser.pageSession("example-page")).not.toBe(sharedSession);
  });
  await inputReady();
  return Object.assign(browser, { advanceRecovery });
}

function loseFrames(browser: ReturnType<typeof mockBrowserCdp>) {
  act(() => {
    browser.disconnect({ code: 1006, wasClean: false }, 1);
  });
}

async function recoveryPending() {
  await screen.findByText("Reconnecting…");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
}

test("Repeated frames loss recovers only capture and waits for a fresh scoped image", async () => {
  const browser = await setupSplitViewer();
  for (let attempt = 0; attempt < 2; attempt++) {
    const original = browser.pageSession("example-page");
    const originalControl = browser.requests.find((request) => {
      return request.sessionId === original;
    })!.connectionId;
    loseFrames(browser);
    await recoveryPending();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toBeEnabled();
    const image = browser.holdTargetFrames("example-page");
    browser.advanceRecovery(4000);
    await image.received;
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      return image.release();
    });
    await inputReady();
    const replacement = browser.pageSession("example-page");
    expect(
      browser.requests.find((request) => {
        return request.sessionId === replacement;
      })!.connectionId,
    ).toBe(originalControl);
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  }
  act(() => {
    return browser.duplicate("other-page");
  });
  await waitFor(() => {
    expect(queryAllByRoleFast("tab")).toHaveLength(3);
  });
  expect(
    screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
  expect(
    browser.requests.filter((request) => {
      return request.method === "Runtime.addBinding";
    }),
  ).toHaveLength(2);
  expect(
    browser.requests.filter((request) => {
      return request.method === "Target.closeTarget";
    }),
  ).toHaveLength(0);
});

test("Frames recovery waits for the original navigation receipt and never replays it", async () => {
  const browser = await setupSplitViewer();
  const receipt = browser.holdNext("Page.navigate");
  await fill(screen.getByLabelText("Address"), "next.example");
  await userEvent.keyboard("{Enter}");
  await receipt.received;
  loseFrames(browser);
  await recoveryPending();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(async () => {
    await receipt.release();
  });
  browser.advanceRecovery(4000);
  await inputReady();
  expect(
    browser.requests.filter((request) => {
      return request.method === "Page.navigate";
    }),
  ).toHaveLength(1);
  expect(screen.getByLabelText("Address")).toHaveValue("http://next.example/");
});

test("Capture closure cannot erase a failed original input receipt", async () => {
  const browser = await setupSplitViewer();
  browser.failNext("Input.insertText", "Input was not acknowledged");
  const receipt = browser.holdNext("Input.insertText");
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "uncertain" },
    inputType: "insertText",
  });
  await receipt.received;
  loseFrames(browser);
  await recoveryPending();
  await act(async () => {
    await receipt.release();
  });
  await screen.findByText("Reconnecting…");
  expect(screen.queryByText("Retry live image")).not.toBeInTheDocument();
  expect(input).toBeDisabled();
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await inputReady();
  expect(screen.getByLabelText("Address")).toHaveValue("https://other.example");
  expect(
    browser.requests.filter((request) => {
      return request.method === "Input.insertText";
    }),
  ).toHaveLength(1);
});

test("A replacement image socket may fail during opening and retry without replacing control", async () => {
  const browser = await setupSplitViewer();
  loseFrames(browser);
  browser.setAutoOpen(false);
  await recoveryPending();
  browser.advanceRecovery(4000);
  await waitFor(() => {
    return expect(browser.connections()).toBe(4);
  });
  loseFrames(browser);
  await recoveryPending();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  browser.setAutoOpen(true);
  browser.advanceRecovery(4000);
  await inputReady();
  expect(
    browser.requests.filter((request) => {
      return request.method === "Runtime.addBinding";
    }),
  ).toHaveLength(2);
});

test("Closing the last tab after frames loss retains a blank without replacing control", async () => {
  const browser = await setupSplitViewer();
  click(screen.getByLabelText("Close Other"));
  await waitFor(() => {
    expect(
      screen.queryByLabelText("Other", { selector: '[role="tab"]' }),
    ).not.toBeInTheDocument();
  });
  loseFrames(browser);
  await recoveryPending();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  const close = screen.getByLabelText("Close Example");
  expect(close).toBeEnabled();
  click(close);
  await inputReady();
  expect(queryAllByRoleFast("tab")).toHaveLength(1);
  expect(
    screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Address")).toHaveValue("");
  expect(
    browser.requests.filter((request) => {
      return request.method === "Runtime.addBinding";
    }),
  ).toHaveLength(2);
});

test("Frames loss during an in-place image retry remains image-retryable", async () => {
  const browser = await setupSplitViewer();
  act(() => {
    return browser.frame("!");
  });
  await recoveryPending();
  const capture = browser.holdNext("Page.startScreencast");
  browser.advanceRecovery(4000);
  await capture.received;
  loseFrames(browser);
  await recoveryPending();
  await act(async () => {
    await capture.release();
  });
  browser.advanceRecovery(4000);
  await inputReady();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("A true control failure after image loss still revokes the whole viewer", async () => {
  const browser = await setupSplitViewer();
  loseFrames(browser);
  await recoveryPending();
  act(() => {
    browser.disconnect({ code: 1006, wasClean: false }, 0);
  });
  await screen.findByText("Reconnecting…");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    screen.getByLabelText("New tab", { selector: "button" }),
  ).toBeDisabled();
});

test("A target moved to a sibling window during image loss is not recovered into the viewer", async () => {
  const browser = await setupSplitViewer();
  loseFrames(browser);
  await recoveryPending();
  act(() => {
    return browser.move("example-page", 1);
  });
  await inputReady();
  expect(
    screen.queryByLabelText("Example", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Address")).toHaveValue("https://other.example");
});
