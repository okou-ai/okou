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

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/frames-recovery";

async function inputReady() {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

async function setupSplitViewer() {
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
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: session });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, {
      browser: session,
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await inputReady();
  click(screen.getByLabelText("Browser settings"));
  const settings = await screen.findByRole("menu", {
    name: "Browser settings",
  });
  click(within(settings).getByText("Connection mode"));
  const mode = await screen.findByRole("menu", { name: "Connection mode" });
  click(within(mode).getByText("Separate image connection"));
  await inputReady();
  return browser;
}

function loseFrames(browser: ReturnType<typeof mockBrowserCdp>) {
  act(() => {
    browser.disconnect({ code: 1006, wasClean: false }, 1);
  });
}

async function retryButton() {
  const button = await screen.findByText("Retry live image");
  await waitFor(() => {
    return expect(button).toBeEnabled();
  });
  return button;
}

test("Repeated frames loss recovers only capture and waits for a fresh scoped image", async () => {
  const browser = await setupSplitViewer();
  for (let attempt = 0; attempt < 2; attempt++) {
    const original = browser.pageSession("example-page");
    const originalControl = browser.requests.find((request) => {
      return request.sessionId === original;
    })!.connectionId;
    loseFrames(browser);
    const retry = await retryButton();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toBeEnabled();
    const image = browser.holdTargetFrames("example-page");
    click(retry);
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

test.each(["navigation", "input"] as const)(
  "Frames recovery waits for the original %s receipt and never replays it",
  async (effect) => {
    const browser = await setupSplitViewer();
    const method =
      effect === "navigation" ? "Page.navigate" : "Input.insertText";
    const receipt = browser.holdNext(method);
    if (effect === "navigation") {
      await fill(screen.getByLabelText("Address"), "next.example");
      await userEvent.keyboard("{Enter}");
    } else {
      const input = screen.getByLabelText("Remote browser input");
      await userEvent.click(input);
      fireEvent.input(input, {
        target: { value: "once" },
        inputType: "insertText",
      });
    }
    await receipt.received;
    loseFrames(browser);
    const retry = await screen.findByText("Retry live image");
    expect(retry).toBeDisabled();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    await act(async () => {
      await receipt.release();
    });
    await waitFor(() => {
      return expect(retry).toBeEnabled();
    });
    click(retry);
    await inputReady();
    expect(
      browser.requests.filter((request) => {
        return request.method === method;
      }),
    ).toHaveLength(1);
    expect(screen.getByLabelText("Address")).toHaveValue(
      effect === "navigation" ? "http://next.example/" : "https://example.com",
    );
  },
);

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
  const retry = await screen.findByText("Retry live image");
  expect(retry).toBeDisabled();
  await act(async () => {
    await receipt.release();
  });
  await screen.findByText("Reconnect");
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

test("A late capture configuration receipt cannot replace recovered imagery", async () => {
  const browser = await setupSplitViewer();
  const capture = browser.holdNext("Page.stopScreencast");
  click(screen.getByLabelText("Browser settings"));
  fireEvent.change(
    await screen.findByRole("spinbutton", { name: "Image quality" }),
    { target: { value: "60" } },
  );
  await capture.received;
  await userEvent.keyboard("{Escape}");
  loseFrames(browser);
  click(await retryButton());
  await inputReady();
  await act(async () => {
    await capture.release();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(browser.captures.at(-1)).toMatchObject({ quality: 60 });
});

test("A replacement image socket may fail during opening and retry without replacing control", async () => {
  const browser = await setupSplitViewer();
  loseFrames(browser);
  browser.setAutoOpen(false);
  click(await retryButton());
  await waitFor(() => {
    return expect(browser.connections()).toBe(4);
  });
  loseFrames(browser);
  const retry = await retryButton();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  browser.setAutoOpen(true);
  click(retry);
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
  await retryButton();
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

test("Frames loss during new-tab capture retries that tab without creating a duplicate", async () => {
  const browser = await setupSplitViewer();
  const capture = browser.holdNext("Page.startScreencast");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await capture.received;
  loseFrames(browser);
  const retry = await retryButton();
  await act(async () => {
    await capture.release();
  });
  click(retry);
  await inputReady();
  expect(queryAllByRoleFast("tab")).toHaveLength(3);
  expect(screen.getByLabelText("Address")).toHaveValue("");
});

test("Frames loss during an in-place image retry remains image-retryable", async () => {
  const browser = await setupSplitViewer();
  act(() => {
    return browser.frame("!");
  });
  const retry = await retryButton();
  const capture = browser.holdNext("Page.startScreencast");
  click(retry);
  await capture.received;
  loseFrames(browser);
  const retryAgain = await retryButton();
  await act(async () => {
    await capture.release();
  });
  click(retryAgain);
  await inputReady();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("A late old-frame decode failure cannot poison the replacement image", async () => {
  const browser = await setupSplitViewer();
  const decoding = context.mocks.deferred<ImageBitmap>();
  const received = context.mocks.deferred<void>();
  vi.spyOn(globalThis, "createImageBitmap").mockImplementationOnce(() => {
    received.resolve();
    return decoding.promise;
  });
  act(() => {
    return browser.frame("AAAA");
  });
  await received.promise;
  loseFrames(browser);
  click(await retryButton());
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    decoding.reject(new Error("old image decode failed"));
  });
  await inputReady();
  expect(screen.queryByText("Retry live image")).not.toBeInTheDocument();
});

test("Changing selection while the replacement socket opens never restores the retired target", async () => {
  const browser = await setupSplitViewer();
  loseFrames(browser);
  browser.setAutoOpen(false);
  click(await retryButton());
  await waitFor(() => {
    return expect(browser.connections()).toBe(4);
  });
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  act(() => {
    return browser.openConnection();
  });
  await inputReady();
  expect(screen.getByLabelText("Address")).toHaveValue("https://other.example");
  expect(browser.connections()).toBe(4);
});

test("Unmount closes an opening replacement socket and cannot revive the viewer", async () => {
  const browser = await setupSplitViewer();
  loseFrames(browser);
  browser.setAutoOpen(false);
  click(await retryButton());
  await waitFor(() => {
    return expect(browser.connections()).toBe(4);
  });
  act(() => {
    window.history.pushState(null, "", "/missing-frames-recovery-page");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => {
    return expect(browser.activeConnections()).toBe(0);
  });
  act(() => {
    return browser.openConnection();
  });
  expect(
    screen.queryByLabelText("Remote browser viewer"),
  ).not.toBeInTheDocument();
});

test.each(["control", "extension", "window"] as const)(
  "A true %s failure after image loss still revokes the whole viewer",
  async (failure) => {
    const browser = await setupSplitViewer();
    loseFrames(browser);
    await retryButton();
    act(() => {
      if (failure === "control") {
        browser.disconnect({ code: 1006, wasClean: false }, 0);
      } else if (failure === "extension") {
        browser.resetWorker();
      } else {
        browser.nativeEvent("window-removed", undefined, { windowId: 0 });
      }
    });
    await screen.findByText("Browser disconnected");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
  },
);

test("A target moved to a sibling window during image loss is not recovered into the viewer", async () => {
  const browser = await setupSplitViewer();
  loseFrames(browser);
  await retryButton();
  act(() => {
    return browser.move("example-page", 1);
  });
  await inputReady();
  expect(
    screen.queryByLabelText("Example", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Address")).toHaveValue("https://other.example");
});
