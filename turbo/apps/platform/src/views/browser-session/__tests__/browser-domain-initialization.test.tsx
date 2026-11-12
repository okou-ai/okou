import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockMonotonicNow, mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/domain-initialization";
const domains = ["Inspector.enable", "Page.enable"] as const;

function viewer() {
  let elapsed = 0;
  const now = Date.parse("2026-09-01T10:00:00.000Z");
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  mockNow(() => {
    return now + elapsed;
  }, context.signal);
  const session: BrowserSession = {
    threadId,
    name: "domain initialization",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: null,
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    screen: { width: 1440, height: 900, resizable: true },
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 101,
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
  const browser = mockBrowserCdp(context, endpoint, {
    targets: [
      {
        targetId: "first",
        title: "First",
        url: "https://first.example",
        windowId: 101,
      },
      {
        targetId: "other",
        title: "Other",
        url: "https://other.example",
        windowId: 101,
      },
      {
        targetId: "sibling",
        title: "Sibling",
        url: "https://sibling.example",
        windowId: 202,
      },
    ],
  });
  return {
    browser,
    start: () => {
      return setupPage({
        context,
        path: `/browsers/${threadId}`,
      });
    },
    advance(ms: number) {
      act(() => {
        elapsed += ms;
      });
    },
  };
}

async function ready(url = "https://first.example") {
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(url);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
}

async function typeOnce(
  browser: ReturnType<typeof mockBrowserCdp>,
  text: string,
) {
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, { target: { value: text }, inputType: "insertText" });
  await waitFor(() => {
    expect(
      browser.input.filter((entry) => {
        return entry.method === "Input.insertText";
      }),
    ).toStrictEqual([expect.objectContaining({ params: { text } })]);
  });
}

test.each(domains)(
  "Both domains settle before input is enabled (%s replies first)",
  async (first) => {
    const { browser, start } = viewer();
    const inspector = browser.holdNext("Inspector.enable");
    const page = browser.holdNext("Page.enable");
    await start();
    await Promise.all([inspector.received, page.received]);
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    await act(first === "Inspector.enable" ? inspector.release : page.release);
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    await act(first === "Inspector.enable" ? page.release : inspector.release);
    await ready();
    await typeOnce(browser, "first input");
  },
);

test.each(domains)(
  "A failed %s retires its attachment before a late peer can revive it",
  async (method) => {
    const { browser, start } = viewer();
    const peer = browser.holdNext(
      method === "Inspector.enable" ? "Page.enable" : "Inspector.enable",
    );
    const failed = browser.holdNext(method);
    browser.failNext(method, "Unavailable method", -32_601);
    await start();
    await Promise.all([peer.received, failed.received]);
    const original = browser.pageSession("first");
    await act(failed.release);
    await screen.findByText("Browser view unavailable");
    await waitFor(() => {
      expect(browser.detached).toContain(original);
    });
    await act(peer.release);
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(browser.input).toHaveLength(0);
  },
);

test.each(domains)(
  "Replacing a selection while %s is pending cannot retire its successor",
  async (method) => {
    const { browser, start } = viewer();
    const held = browser.holdNext(method);
    await start();
    await held.received;
    const original = browser.pageSession("first");
    click(await screen.findByLabelText("Other", { selector: '[role="tab"]' }));
    await ready("https://other.example");
    const successor = browser.pageSession("other");
    await act(held.release);
    await ready("https://other.example");
    expect(browser.detached).toContain(original);
    expect(browser.detached).not.toContain(successor);
    await typeOnce(browser, "successor input");
  },
);

test.each(domains)(
  "Target loss during %s retains the surviving owned tab",
  async (method) => {
    const { browser, start } = viewer();
    const held = browser.holdNext(method);
    await start();
    await held.received;
    act(() => {
      browser.event("Target.targetDestroyed", { targetId: "first" });
    });
    await ready("https://other.example");
    await act(held.release);
    await ready("https://other.example");
    expect(
      screen.queryByLabelText("First", { selector: '[role="tab"]' }),
    ).not.toBeInTheDocument();
    await typeOnce(browser, "survivor input");
  },
);

test.each(domains)(
  "Window loss during %s cannot publish input or expose sibling tabs",
  async (method) => {
    const { browser, start } = viewer();
    const held = browser.holdNext(method);
    await start();
    await held.received;
    act(() => {
      browser.targets.splice(0, 2);
      browser.nativeEvent("window-removed", undefined, { windowId: 101 });
    });
    await screen.findByText("Browser disconnected");
    await act(held.release);
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
    ).not.toBeInTheDocument();
    expect(browser.input).toHaveLength(0);
  },
);

test.each(domains)(
  "Unmounting with %s pending closes connections despite a late reply",
  async (method) => {
    const { browser, start } = viewer();
    const held = browser.holdNext(method);
    await start();
    await held.received;
    act(cleanup);
    await waitFor(() => {
      expect(browser.activeConnections()).toBe(0);
    });
    await act(held.release);
    expect(
      screen.queryByLabelText("Remote browser input"),
    ).not.toBeInTheDocument();
  },
);

test("A connection-mode change during enabling retains the new mode's session", async () => {
  const { browser, start } = viewer();
  const held = browser.holdNext("Inspector.enable");
  await start();
  await held.received;
  const original = browser.pageSession("first");
  click(screen.getByLabelText("Browser settings"));
  const settings = await screen.findByRole("menu", {
    name: "Browser settings",
  });
  click(within(settings).getByText("Connection mode"));
  const modes = await screen.findByRole("menu", { name: "Connection mode" });
  click(within(modes).getByText("Separate image connection"));
  await ready();
  const successor = browser.pageSession("first");
  expect(successor).not.toBe(original);
  await act(held.release);
  await ready();
  expect(browser.detached).not.toContain(successor);
  await typeOnce(browser, "split input");
});

test("A lost connection while enabling recovers without reviving the old receipt", async () => {
  const { browser, start, advance } = viewer();
  const held = browser.holdNext("Page.enable");
  await start();
  await held.received;
  act(() => {
    browser.disconnect({ code: 1006, reason: "temporary loss" });
  });
  await screen.findByText("Reconnecting…");
  advance(1000);
  await ready();
  await act(held.release);
  await ready();
  expect(browser.connections()).toBe(2);
  await typeOnce(browser, "reconnected input");
});

test.each(domains)(
  "A silent %s retains its original response deadline and recovers once",
  async (method) => {
    const { browser, start, advance } = viewer();
    const held = browser.holdNext(method);
    await start();
    await held.received;
    advance(31_000);
    await screen.findByText("Reconnecting…");
    advance(1000);
    await ready();
    await act(held.release);
    await ready();
    expect(browser.connections()).toBe(2);
    await typeOnce(browser, "deadline recovery");
  },
);

test.each(domains)(
  "A terminal %s failure is retained when its peer never replies",
  async (method) => {
    const { browser, start, advance } = viewer();
    const failure = browser.holdNext(method);
    browser.holdNext(
      method === "Inspector.enable" ? "Page.enable" : "Inspector.enable",
    );
    browser.failNext(method, "Unavailable method", -32_601);
    await start();
    await failure.received;
    const original = browser.pageSession("first");
    await act(failure.release);
    await screen.findByText("Browser view unavailable");
    expect(browser.detached).toContain(original);
    advance(31_000);
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(browser.connections()).toBe(1);
  },
);
