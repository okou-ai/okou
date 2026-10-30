import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

function mockViewer(
  windowId?: number,
  unavailableTargets?: readonly string[],
  extensionAvailable = true,
) {
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
    ...(windowId === undefined
      ? {}
      : {
          window: {
            instanceId: "22222222-2222-4222-8222-222222222222",
            primaryWindowId: windowId,
          },
        }),
  };
  const cdpUrl = "wss://browser.example/interactions";
  const browser = mockBrowserCdp(context, cdpUrl, {
    extensionAvailable,
    unavailableTargets,
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
        url: "https://other.example.com",
        windowId: 1,
      },
    ],
  });
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

async function setupViewer(windowId?: number) {
  const browser = mockViewer(windowId);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  return browser;
}

test.each([undefined, 0])(
  "New tabs can be created and closed in window %s",
  async (windowId) => {
    const browser = await setupViewer(windowId);
    await userEvent.click(
      screen.getByLabelText("New tab", { selector: "button" }),
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByLabelText("Address")).toHaveValue("");
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveFocus();
    });
    expect(
      browser.targets.find((target) => {
        return target.targetId === "created-1";
      }),
    ).toMatchObject({ url: "about:blank", windowId: 0 });
    await userEvent.click(screen.getByLabelText("Close New tab"));
    const successor = windowId === undefined ? "Other" : "Example";
    await waitFor(() => {
      expect(
        screen.getByLabelText(successor, { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText(successor, { selector: '[role="tab"]' }),
      ).toHaveFocus();
    });
    expect(
      browser.targets.map((target) => {
        return target.targetId;
      }),
    ).toStrictEqual(["example-page", "other-page"]);
  },
);

test("Submitting an address navigates the selected remote page", async () => {
  const browser = await setupViewer(0);
  const address = screen.getByLabelText("Address");
  await fill(address, "example.test/path");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://example.test/path");
  });
  expect(browser.targets[0]?.url).toBe("http://example.test/path");
  expect(browser.targets[1]?.url).toBe("https://other.example.com");
});

test("Moving another page into the window preserves the selected page and input", async () => {
  const browser = await setupViewer(0);
  const membership = browser.holdNext("Browser.getWindowForTarget");
  act(() => {
    browser.move("other-page", 0);
  });
  await membership.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  await membership.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "false");
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("A selected page moved away loses input while remaining pages stay selectable", async () => {
  const browser = await setupViewer(0);
  act(() => {
    browser.move("other-page", 0);
  });
  await screen.findByLabelText("Other", { selector: '[role="tab"]' });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  act(() => {
    browser.move("example-page", 1);
  });
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    screen.queryByLabelText("Example", { selector: '[role="tab"]' }),
  ).toBeNull();
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test.each(["sequence gap", "worker replacement"])(
  "A native %s revokes the established viewer",
  async (failure) => {
    const browser = await setupViewer(0);
    act(() => {
      if (failure === "worker replacement") {
        browser.resetWorker();
      } else {
        browser.skipNativeEvent();
        browser.nativeEvent("tab-updated");
      }
    });
    await screen.findByText("Browser disconnected");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
  },
);

test("An empty assigned window can create a native tab without a source document", async () => {
  const browser = mockViewer(0);
  browser.targets.splice(0, 1);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("No tabs open");
  await userEvent.click(
    screen.getByLabelText("New tab", { selector: "button" }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("");
  expect(
    browser.targets.find((target) => {
      return target.targetId === "created-1";
    }),
  ).toMatchObject({ windowId: 0, url: "about:blank" });
});

test("An unavailable required extension never admits CDP-only viewing", async () => {
  mockViewer(0, undefined, false);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    screen.getByLabelText("New tab", { selector: "button" }),
  ).toBeDisabled();
});

test("Bridge loss waits for the original modifier release before detaching its page", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
      }),
    );
  });
  const release = browser.holdNext("Input.dispatchKeyEvent");
  act(() => {
    browser.resetWorker();
  });
  await release.received;
  await screen.findByText("Browser disconnected");
  expect(browser.detached).not.toContain("example-page-session");
  await release.release();
  await waitFor(() => {
    expect(browser.detached).toContain("example-page-session");
  });
  expect(browser.targets).toHaveLength(2);
});

test.each(["movement", "pending navigation"])(
  "A delayed creation receipt preserves another caller's %s",
  async (change) => {
    const browser = await setupViewer(0);
    const receipt = browser.holdNext("Runtime.evaluate");
    await userEvent.click(
      screen.getByLabelText("New tab", { selector: "button" }),
    );
    await receipt.received;
    act(() => {
      if (change === "movement") {
        browser.move("created-1", 1);
      } else {
        browser.beginNavigation(
          "created-1",
          "https://user-navigation.example.com",
        );
      }
    });
    await receipt.release();
    await screen.findByText(
      "The browser action could not be completed. Check the browser before trying again.",
    );
    expect(
      browser.targets.find((target) => {
        return target.targetId === "created-1";
      }),
    ).toMatchObject(
      change === "movement"
        ? { windowId: 1 }
        : { pendingUrl: "https://user-navigation.example.com" },
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  },
);

test.each([
  ["[::1]:8080/path", "http://[::1]:8080/path"],
  ["例子.测试/你好", "http://xn--fsqu00a.xn--0zwm56d/%E4%BD%A0%E5%A5%BD"],
  ["custom:payload", "custom:payload"],
])(
  "The address field normalizes %s for the remote page",
  async (address, expected) => {
    const browser = await setupViewer(0);
    await fill(screen.getByLabelText("Address"), address);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveValue(expected);
    });
    expect(browser.targets[0]?.url).toBe(expected);
  },
);

test("IME confirmation commits text once to the current remote session", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "中" },
    data: "中",
    inputType: "insertCompositionText",
    isComposing: true,
  });
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  fireEvent.input(input, {
    target: { value: "中" },
    data: "中",
    inputType: "insertCompositionText",
    isComposing: false,
  });
  await waitFor(() => {
    expect(
      browser.input.filter((request) => {
        return request.method === "Input.insertText";
      }),
    ).toStrictEqual([
      {
        method: "Input.insertText",
        params: { text: "中" },
        sessionId: "example-page-session",
      },
    ]);
  });
  expect(input).toHaveFocus();
});

test("A payload-less context reset retires composition before accepting new remote text", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "old" },
    data: "old",
    inputType: "insertCompositionText",
    isComposing: true,
  });
  act(() => {
    browser.event(
      "Runtime.executionContextsCleared",
      undefined,
      "example-page-session",
    );
  });
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "old",
    }),
  );
  fireEvent.input(input, {
    target: { value: "fresh" },
    data: "fresh",
    inputType: "insertText",
    isComposing: false,
  });
  await waitFor(() => {
    expect(
      browser.input.filter((request) => {
        return request.method === "Input.insertText";
      }),
    ).toStrictEqual([
      {
        method: "Input.insertText",
        sessionId: "example-page-session",
        params: { text: "fresh" },
      },
    ]);
  });
});

test("Retrying an image waits for both original input and capture cleanup", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  const pendingInput = browser.holdNext("Input.insertText");
  fireEvent.input(input, {
    target: { value: "typed" },
    inputType: "insertText",
  });
  await pendingInput.received;
  const pendingStop = browser.holdNext("Page.stopScreencast");
  act(() => {
    browser.frame("!");
  });
  await pendingStop.received;
  await screen.findByText("Browser view unavailable");
  function retryButton() {
    const button = queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.trim() === "Retry live image";
    });
    if (!button) {
      throw new Error("Missing image recovery control");
    }
    return button;
  }
  expect(retryButton()).toBeDisabled();
  await pendingInput.release();
  expect(retryButton()).toBeDisabled();
  await pendingStop.release();
  await waitFor(() => {
    expect(retryButton()).toBeEnabled();
  });
  await userEvent.click(retryButton());
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("Closing a tab preserves address focus chosen while the close is pending", async () => {
  const browser = await setupViewer();
  const closed = browser.holdNext("Target.closeTarget");
  await userEvent.click(screen.getByLabelText("Close Other"));
  await closed.received;
  const address = screen.getByLabelText("Address");
  await fill(address, "draft.example");
  await closed.release();
  await waitFor(() => {
    expect(
      screen.getByLabelText("Example", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(address).toHaveFocus();
  expect(address).toHaveValue("draft.example");
  expect(
    browser.targets.map((target) => {
      return target.title;
    }),
  ).toStrictEqual(["Example"]);
});

test("Shared tab controls support keyboard selection and address Escape", async () => {
  const browser = await setupViewer();
  await userEvent.click(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  );
  await userEvent.keyboard("{ArrowRight}");
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveFocus();
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toBeEnabled();
  });
  await fill(screen.getByLabelText("Address"), "unfinished.example");
  await userEvent.keyboard("{Escape}");
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
  expect(screen.getByLabelText("Address")).toHaveFocus();
  expect(browser.targets[1]?.url).toBe("https://other.example.com");
});

test("A search-like address reports the failed action and retains the remote page", async () => {
  const browser = await setupViewer(0);
  await fill(screen.getByLabelText("Address"), "find some text");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Address")).toHaveValue("find some text");
  expect(browser.targets[0]?.url).toBe("https://example.com");
});

test("A hidden page pauses input and resumes the selected tab when visible", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  await setupViewer();
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
  });
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    visibility.changeTo("visible");
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test("An old image cleanup cannot replace a newly selected tab", async () => {
  const browser = await setupViewer();
  const stop = browser.holdNext("Page.stopScreencast");
  act(() => {
    browser.frame("!");
  });
  await stop.received;
  await screen.findByText("Browser view unavailable");
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await stop.release();
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test("A late modifier cleanup stays on its original tab while the successor keeps editing", async () => {
  const browser = await setupViewer();
  const original = screen.getByLabelText("Remote browser input");
  await userEvent.click(original);
  fireEvent.keyDown(original, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        sessionId: "example-page-session",
        params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
      }),
    );
  });
  const release = browser.holdNext("Input.dispatchKeyEvent");
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await release.received;
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const successor = screen.getByLabelText("Remote browser input");
  await userEvent.click(successor);
  fireEvent.keyDown(successor, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        sessionId: "other-page-session",
        params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
      }),
    );
  });
  await release.release();
  fireEvent.keyUp(successor, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        sessionId: "other-page-session",
        params: expect.objectContaining({ type: "keyUp", key: "Shift" }),
      }),
    );
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test("A background window lookup failure leaves a valid scoped tab usable", async () => {
  mockViewer(0, ["other-page"]);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Example"]);
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("A held initial inventory cannot resurrect a target destroyed before its reply", async () => {
  const browser = mockViewer();
  const inventory = browser.holdNext("Target.getTargets");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await inventory.received;
  act(() => {
    browser.event("Target.targetDestroyed", { targetId: "example-page" });
  });
  await inventory.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Other"]);
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test("The overflow menu keeps hidden tabs reachable through shared controls", async () => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("role") === "tablist"
        ? new DOMRect(0, 0, 70, 36)
        : original.call(this);
    },
  );
  await setupViewer();
  await userEvent.click(screen.getByLabelText("All tabs"));
  const menu = await screen.findByRole("menu");
  const other = queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === "Other";
  });
  if (!other) {
    throw new Error("Missing overflow tab");
  }
  await userEvent.click(other);
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
  });
  expect(screen.getByLabelText("All tabs")).toHaveFocus();
});

test("Capture controls apply the selected format to the remote browser", async () => {
  const browser = await setupViewer(0);
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.click(await screen.findByText("Image format"));
  const menu = await screen.findByRole("menu", { name: "Image format" });
  const png = queryAllByRoleFast("menuitemradio", menu).find((item) => {
    return item.textContent?.trim() === "PNG";
  });
  if (!png) {
    throw new Error("Missing PNG option");
  }
  await userEvent.click(png);
  await waitFor(() => {
    expect(browser.captures.at(-1)).toMatchObject({ format: "png" });
  });
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await expect(
    screen.findByRole("spinbutton", { name: "Image quality" }),
  ).resolves.toBeDisabled();
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
});

test("Following the panel applies its display size and leaves remote input usable", async () => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this instanceof HTMLCanvasElement
        ? new DOMRect(0, 0, 900, 600)
        : original.call(this);
    },
  );
  const browser = await setupViewer(0);
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
  });
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});
