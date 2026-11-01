import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
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

test.each(["first image", "input initialization"] as const)(
  "Selecting a tab waits for its %s before accepting another browser action",
  async (waitingFor) => {
    const browser = await setupViewer();
    const pending =
      waitingFor === "first image"
        ? browser.holdFrames("other-page-session")
        : browser.holdNext("Runtime.enable");
    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await act(async () => {
      await pending.received;
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Other", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(screen.getByLabelText("Address")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();

    await act(async () => {
      await pending.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeEnabled();
  },
);

test("A created tab with a failed first image retries the image without creating another tab", async () => {
  const browser = await setupViewer(0);
  const image = browser.holdFrames("created-1-session");
  const created = browser.holdNextNative("createTab");
  const newTab = screen.getByLabelText("New tab", { selector: "button" });
  click(newTab);
  await created.received;
  expect(browser.targets).toContainEqual(
    expect.objectContaining({
      targetId: "created-1",
      url: expect.stringMatching(/^about:blank#okou-create-/),
    }),
  );
  expect(newTab).toBeDisabled();
  await userEvent.click(newTab);

  await act(async () => {
    await created.release();
  });
  await image.received;
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(newTab).toBeDisabled();
  await userEvent.click(newTab);

  act(() => {
    image.release("!");
  });
  await screen.findByText("Browser view unavailable");
  const retry = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Retry live image";
  });
  if (!retry) {
    throw new Error("Missing image recovery control");
  }
  await waitFor(() => {
    expect(retry).toBeEnabled();
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(newTab).toBeDisabled();
  click(retry);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Example", "New tab"]);
  expect(screen.getByLabelText("Address")).toHaveValue("");
});

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

test("An address submission waits for its navigation receipt across its own document change", async () => {
  const browser = await setupViewer(0);
  const navigation = browser.holdNext("Page.navigate");
  const address = screen.getByLabelText("Address");
  await fill(address, "first.example/path");
  await userEvent.keyboard("{Enter}");
  await navigation.received;
  await waitFor(() => {
    expect(
      screen.getByLabelText("first.example", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(address).toBeDisabled();

  await act(async () => {
    await navigation.release();
  });
  await waitFor(() => {
    expect(address).toBeEnabled();
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await fill(address, "second.example/ready");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://second.example/ready");
  });
  expect(browser.targets[0]?.url).toBe("http://second.example/ready");
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

test("Bridge loss detaches its page after writing an unacknowledged modifier release", async () => {
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
  // The remote never acknowledges the release while the viewer closes.
  const release = browser.holdNext("Input.dispatchKeyEvent");
  act(() => {
    browser.resetWorker();
  });
  await release.received;
  await screen.findByText("Browser disconnected");
  await waitFor(() => {
    expect(browser.detached).toContain("example-page-session");
  });
  // The release was written before its page was detached.
  const keyUp = browser.requests.findIndex((request) => {
    return (
      request.method === "Input.dispatchKeyEvent" &&
      request.params?.type === "keyUp"
    );
  });
  const pageDetach = browser.requests.findIndex((request) => {
    return (
      request.method === "Target.detachFromTarget" &&
      request.params?.sessionId === "example-page-session"
    );
  });
  expect(keyUp).toBeGreaterThan(-1);
  expect(keyUp).toBeLessThan(pageDetach);
  expect(browser.targets).toHaveLength(2);
  // The closed incarnation no longer blocks reconnecting to the same browser.
  const reconnect = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Reconnect";
  });
  if (!reconnect) {
    throw new Error("Missing reconnect control");
  }
  click(reconnect);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("Revalidation does not wait for an unacknowledged release before another tab can be used", async () => {
  const browser = await setupViewer();
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
  // Revalidation revokes admission; the remote never acknowledges the release.
  const release = browser.holdNext("Input.dispatchKeyEvent");
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await release.received;
  await userEvent.click(
    await screen.findByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test.each(["movement", "pending navigation"])(
  "A delayed creation receipt preserves another caller's %s",
  async (change) => {
    const browser = await setupViewer(0);
    const receipt = browser.holdNextNative("createTab");
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

test("A fresh native tab read covers preceding metadata updates during creation", async () => {
  const browser = await setupViewer(0);
  browser.updateBeforeNextTabRead();
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("");
  expect(
    browser.targets.find((target) => {
      return target.targetId === "created-1";
    }),
  ).toMatchObject({ url: "about:blank", windowId: 0 });
});

test.each(["native getTab", "Browser.getWindowForTarget"])(
  "A delayed creation check (%s) preserves another caller's pending navigation",
  async (method) => {
    const browser = await setupViewer(0);
    const attachment = browser.holdNext("Target.attachToTarget");
    click(screen.getByLabelText("New tab", { selector: "button" }));
    await attachment.received;
    const observation =
      method === "native getTab"
        ? browser.holdNextNative("getTab")
        : browser.holdNextMembership("created-1");
    await attachment.release();
    await observation.received;
    act(() => {
      browser.beginNavigation(
        "created-1",
        "https://user-navigation.example.com",
      );
    });
    await observation.release();
    await waitFor(() => {
      expect(
        screen.getByLabelText("New tab", {
          selector: 'button:not([role="tab"])',
        }),
      ).toBeEnabled();
    });
    expect(
      browser.targets.find((target) => {
        return target.targetId === "created-1";
      }),
    ).toMatchObject({
      url: expect.stringMatching(/^about:blank#okou-create-/),
      pendingUrl: "https://user-navigation.example.com",
    });
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(
      screen.getByText(
        "The browser action could not be completed. Check the browser before trying again.",
      ),
    ).toBeInTheDocument();
  },
);

test("A delayed failed-create cleanup preserves another caller's pending navigation", async () => {
  const browser = await setupViewer(0);
  browser.corruptNextPageAttachment();
  const attachment = browser.holdNext("Target.attachToTarget");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await attachment.received;
  const cleanup = browser.holdNextNative("getTab");
  await attachment.release();
  await cleanup.received;
  act(() => {
    browser.beginNavigation("created-1", "https://user-navigation.example.com");
  });
  await cleanup.release();
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", {
        selector: 'button:not([role="tab"])',
      }),
    ).toBeEnabled();
  });
  expect(
    browser.targets.find((target) => {
      return target.targetId === "created-1";
    }),
  ).toMatchObject({
    url: expect.stringMatching(/^about:blank#okou-create-/),
    pendingUrl: "https://user-navigation.example.com",
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(
    screen.getByText(
      "The browser action could not be completed. Check the browser before trying again.",
    ),
  ).toBeInTheDocument();
});

test("A malformed new-page attachment preserves the established browser pages", async () => {
  const browser = await setupViewer(0);
  browser.corruptNextPageAttachment();
  await userEvent.click(
    screen.getByLabelText("New tab", { selector: "button" }),
  );
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(
    browser.targets.map((target) => {
      return target.targetId;
    }),
  ).toStrictEqual(["example-page", "other-page"]);
});

test("A duplicate marker during creation never takes over the other caller's page", async () => {
  const browser = await setupViewer(0);
  const receipt = browser.holdNextNative("createTab");
  await userEvent.click(
    screen.getByLabelText("New tab", { selector: "button" }),
  );
  await receipt.received;
  act(() => {
    browser.duplicate("created-1");
  });
  await receipt.release();
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(
    browser.targets.map((target) => {
      return target.targetId;
    }),
  ).toStrictEqual(["example-page", "other-page", "created-2"]);
  expect(browser.targets.at(-1)?.url).toMatch(/^about:blank#okou-create-/);
});

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

test("Remote editing context configures one stable selection-capable keyboard proxy", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  for (const [type, inputMode, enterKeyHint] of [
    ["search", "search", "search"],
    ["email", "email", "enter"],
    ["url", "url", "enter"],
    ["tel", "tel", "enter"],
    ["number", "decimal", "enter"],
    ["textarea", "text", "enter"],
    ["password", "text", "enter"],
  ]) {
    browser.setFocusedEditing({
      x: 40,
      y: 50,
      width: 1440,
      height: 900,
      offsetX: 0,
      offsetY: 0,
      editing: {
        type,
        multiline: type === "textarea",
        inputMode: "",
        enterKeyHint: "",
        autoCapitalize: "characters",
        lang: "zh-CN",
      },
    });
    fireEvent.keyDown(input, { key: "Tab", code: "Tab", keyCode: 9 });
    fireEvent.keyUp(input, { key: "Tab", code: "Tab", keyCode: 9 });
    await waitFor(() => {
      expect(input).toHaveAttribute("inputmode", inputMode);
      expect(input).toHaveAttribute("enterkeyhint", enterKeyHint);
      expect(input).toHaveAttribute(
        "type",
        type === "password" ? "password" : "text",
      );
    });
    expect(input).toHaveFocus();
    expect(screen.getByLabelText("Remote browser input")).toBe(input);
    expect(input).toHaveAttribute("lang", "zh-CN");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
  }
  expect(input).toHaveAttribute("autocapitalize", "none");
  browser.setFocusedEditing({
    x: 40,
    y: 50,
    width: 1440,
    height: 900,
    offsetX: 0,
    offsetY: 0,
    editing: {
      type: "text",
      multiline: false,
      inputMode: "numeric",
      enterKeyHint: "send",
      autoCapitalize: "words",
      lang: "en-US",
    },
  });
  fireEvent.keyDown(input, { key: "Tab", code: "Tab", keyCode: 9 });
  fireEvent.keyUp(input, { key: "Tab", code: "Tab", keyCode: 9 });
  await waitFor(() => {
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("enterkeyhint", "send");
  });
  expect(input).toHaveAttribute("autocapitalize", "words");
  fireEvent.compositionStart(input);
  browser.setFocusedEditing({
    x: 40,
    y: 50,
    width: 1440,
    height: 900,
    offsetX: 0,
    offsetY: 0,
    editing: {
      type: "password",
      multiline: false,
      inputMode: "",
      enterKeyHint: "done",
      autoCapitalize: "characters",
      lang: "ja",
    },
  });
  const reading = browser.holdNext("Runtime.evaluate");
  fireEvent.input(input, {
    target: { value: "中" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await reading.received;
  await act(async () => {
    await reading.release();
  });
  expect(input).toHaveAttribute("type", "text");
  expect(input).toHaveAttribute("inputmode", "numeric");
  expect(input).toHaveValue("中");
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  await waitFor(() => {
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("enterkeyhint", "done");
  });
  expect(input).toHaveFocus();
  browser.setFocusedEditing(null);
  fireEvent.keyDown(input, { key: "Tab", code: "Tab", keyCode: 9 });
  fireEvent.keyUp(input, { key: "Tab", code: "Tab", keyCode: 9 });
  await waitFor(() => {
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("enterkeyhint", "enter");
    expect(input).toHaveAttribute("lang", "");
  });
  expect(input).toHaveFocus();
});

test("A failed editing-context read clears stale keyboard hints without disabling input", async () => {
  const browser = await setupViewer(0);
  browser.setFocusedEditing({
    x: 40,
    y: 50,
    width: 1440,
    height: 900,
    offsetX: 0,
    offsetY: 0,
    editing: {
      type: "text",
      multiline: false,
      inputMode: "none",
      enterKeyHint: "done",
      autoCapitalize: "characters",
      lang: "ja",
    },
  });
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  await waitFor(() => {
    expect(input).toHaveAttribute("inputmode", "none");
  });
  browser.setFocusedEditing(null);
  browser.failNext("Runtime.evaluate", "Cannot find context with specified id");
  fireEvent.keyDown(input, { key: "Tab", code: "Tab", keyCode: 9 });
  fireEvent.keyUp(input, { key: "Tab", code: "Tab", keyCode: 9 });
  await waitFor(() => {
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("enterkeyhint", "enter");
    expect(input).toHaveAttribute("lang", "");
  });
  expect(input).toBeEnabled();
  expect(input).toHaveFocus();
  fireEvent.input(input, {
    target: { value: "fresh" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "fresh" },
    });
  });
});

test.each(["success", "failure"])(
  "A retired tab's delayed %s cannot alter the successor editing context",
  async (outcome) => {
    const browser = await setupViewer();
    browser.setFocusedEditing({
      x: 40,
      y: 50,
      width: 1440,
      height: 900,
      offsetX: 0,
      offsetY: 0,
      editing: {
        type: "password",
        multiline: false,
        inputMode: "numeric",
        enterKeyHint: "done",
        autoCapitalize: "none",
        lang: "ja",
      },
    });
    if (outcome === "failure") {
      browser.failNext(
        "Runtime.evaluate",
        "Cannot find context with specified id",
      );
    }
    const reading = browser.holdNext("Runtime.evaluate");
    await userEvent.click(screen.getByLabelText("Remote browser input"));
    await expect(reading.received).resolves.toContain(
      outcome === "failure" ? '"error"' : '"password"',
    );
    browser.setFocusedEditing({
      x: 40,
      y: 50,
      width: 1440,
      height: 900,
      offsetX: 0,
      offsetY: 0,
      editing: {
        type: "text",
        multiline: false,
        inputMode: "numeric",
        enterKeyHint: "send",
        autoCapitalize: "none",
        lang: "en",
      },
    });
    await userEvent.click(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    await waitFor(() => {
      expect(input).toHaveAttribute("inputmode", "numeric");
      expect(input).toHaveAttribute("enterkeyhint", "send");
    });
    await act(async () => {
      await reading.release();
    });
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("enterkeyhint", "send");
    expect(input).toHaveAttribute("lang", "en");
  },
);

test("Native form actions forward Enter once without submitting an IME candidate", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  const form = input.closest("form")!;
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Unidentified", keyCode: 229 });
  expect(fireEvent.submit(form)).toBeFalsy();
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.submit(form);
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
    }),
  );
  fireEvent.keyUp(input, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "中" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  fireEvent.submit(form);
  expect(
    fireEvent(
      input,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertParagraph",
      }),
    ),
  ).toBeTruthy();
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  fireEvent.input(input, {
    target: { value: "中" },
    inputType: "insertCompositionText",
  });
  fireEvent.input(input, { inputType: "insertLineBreak" });
  for (const inputType of ["insertLineBreak", "insertParagraph"]) {
    expect(
      fireEvent(
        input,
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType,
        }),
      ),
    ).toBeFalsy();
  }
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: "first\nsecond",
    }),
  );
  fireEvent.input(input, {
    target: { value: "last" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "last" },
    });
  });
  const keys = browser.input.filter((request) => {
    return request.method === "Input.dispatchKeyEvent";
  });
  expect(keys).toHaveLength(10);
  for (let index = 0; index < keys.length; index += 2) {
    expect(keys[index]).toMatchObject({
      params: {
        type: "keyDown",
        key: "Enter",
        text: "\r",
        unmodifiedText: "\r",
      },
    });
    expect(keys[index + 1]).toMatchObject({
      params: { type: "keyUp", key: "Enter" },
    });
  }
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.insertText";
    }),
  ).toStrictEqual([
    expect.objectContaining({ params: { text: "中" } }),
    expect.objectContaining({ params: { text: "first\nsecond" } }),
    expect.objectContaining({ params: { text: "last" } }),
  ]);
});

test("Soft-keyboard deletion forwards after committed text without duplicating desktop Backspace", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "d" },
    data: "d",
    inputType: "insertText",
  });
  fireEvent.keyDown(input, {
    key: "Unidentified",
    keyCode: 229,
  });
  for (let index = 0; index < 2; index++) {
    fireEvent(
      input,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
      }),
    );
  }
  fireEvent.keyDown(input, {
    key: "Backspace",
    code: "Backspace",
    keyCode: 8,
  });
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  fireEvent.keyUp(input, {
    key: "Backspace",
    code: "Backspace",
    keyCode: 8,
  });
  fireEvent.input(input, {
    target: { value: "next" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "next" },
    });
  });
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toStrictEqual(
    Array.from({ length: 3 }, () => {
      return [
        {
          method: "Input.dispatchKeyEvent",
          sessionId: "example-page-session",
          params: expect.objectContaining({
            type: "rawKeyDown",
            key: "Backspace",
          }),
        },
        {
          method: "Input.dispatchKeyEvent",
          sessionId: "example-page-session",
          params: expect.objectContaining({ type: "keyUp", key: "Backspace" }),
        },
      ];
    }).flat(),
  );
});

test("Queued soft-keyboard deletion and Enter cannot reach a replacement tab", async () => {
  const browser = await setupViewer();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  // A pending native preedit keeps the subsequent commit and deletion queued.
  const pending = browser.holdNext("Input.imeSetComposition");
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "old" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await pending.received;
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "old",
    }),
  );
  fireEvent.submit(input.closest("form")!);
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await pending.release();
  const successor = screen.getByLabelText("Remote browser input");
  await userEvent.click(successor);
  fireEvent(
    successor,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  fireEvent.input(successor, {
    target: { value: "fresh" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toStrictEqual({
      method: "Input.insertText",
      params: { text: "fresh" },
      sessionId: "other-page-session",
    });
  });
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toStrictEqual([
    {
      method: "Input.dispatchKeyEvent",
      sessionId: "other-page-session",
      params: expect.objectContaining({ type: "rawKeyDown", key: "Backspace" }),
    },
    {
      method: "Input.dispatchKeyEvent",
      sessionId: "other-page-session",
      params: expect.objectContaining({ type: "keyUp", key: "Backspace" }),
    },
  ]);
});

test("Backward deletion preserves preedit and consumes committed composition residuals", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "中国" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
      isComposing: true,
    }),
  );
  fireEvent.input(input, {
    target: { value: "中" },
    inputType: "deleteCompositionText",
    isComposing: true,
  });
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  fireEvent.input(input, {
    inputType: "deleteContentBackward",
  });
  fireEvent.input(input, {
    target: { value: "fresh" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "fresh" },
    });
  });
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.insertText";
    }),
  ).toStrictEqual([
    {
      method: "Input.insertText",
      sessionId: "example-page-session",
      params: { text: "中" },
    },
    {
      method: "Input.insertText",
      sessionId: "example-page-session",
      params: { text: "fresh" },
    },
  ]);
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toStrictEqual([
    {
      method: "Input.dispatchKeyEvent",
      sessionId: "example-page-session",
      params: expect.objectContaining({ type: "rawKeyDown", key: "Backspace" }),
    },
    {
      method: "Input.dispatchKeyEvent",
      sessionId: "example-page-session",
      params: expect.objectContaining({ type: "keyUp", key: "Backspace" }),
    },
  ]);
});

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

test("A close receipt returns focus before the successor has a live image", async () => {
  const browser = await setupViewer();
  const image = browser.holdFrames("other-page-session");
  const closed = browser.holdNext("Target.closeTarget");
  await userEvent.click(screen.getByLabelText("Close Example"));
  await closed.received;
  await act(async () => {
    await closed.release();
  });
  await image.received;
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveFocus();
  });
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Other"]);

  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
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

test("A retired background membership failure cannot revoke the usable selected page", async () => {
  const browser = await setupViewer(0);
  const membership = browser.holdNextMembership("other-page");
  act(() => {
    browser.move("other-page", 0);
  });
  // This request is after the cold list and targets B specifically, not A or
  // the bridge's nested Target.getTargets lookup.
  await membership.received;
  act(() => {
    const index = browser.targets.findIndex((target) => {
      return target.targetId === "other-page";
    });
    browser.targets.splice(index, 1);
    browser.event("Target.targetDestroyed", { targetId: "other-page" });
  });
  await membership.releaseFailure();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText("Other", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "still usable" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual({
      method: "Input.insertText",
      sessionId: "example-page-session",
      params: { text: "still usable" },
    });
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
