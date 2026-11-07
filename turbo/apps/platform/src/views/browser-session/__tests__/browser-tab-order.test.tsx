import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
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
const endpoint = "wss://browser.example/tab-order";

function viewer() {
  const session: BrowserSession = {
    threadId,
    name: "ordering",
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
  const connection = {
    browser: session,
    cdpUrl: endpoint,
    extension: TEST_BROWSER_EXTENSION,
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: session, viewer: connection });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, connection);
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  const browser = mockBrowserCdp(context, endpoint, {
    targets: [
      {
        targetId: "first",
        title: "First",
        url: "https://same.example/",
        windowId: 101,
      },
      {
        targetId: "second",
        title: "Second",
        url: "https://same.example/",
        windowId: 101,
      },
      {
        targetId: "blank",
        title: "about:blank",
        url: "about:blank",
        windowId: 101,
      },
      {
        targetId: "foreign",
        title: "Foreign",
        url: "https://same.example/",
        windowId: 202,
      },
    ],
    nativeOrder: ["blank", "second", "first", "foreign"],
  });
  return {
    browser,
    start() {
      return setupPage({
        context,
        path: `/browsers/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.BrowserSharedOwner]: true },
      });
    },
  };
}

function tabNames() {
  return queryAllByRoleFast("tab").map((tab) => {
    return tab.getAttribute("aria-label");
  });
}

async function ordered(names = ["New tab", "Second", "First"]) {
  await waitFor(() => {
    return expect(tabNames()).toStrictEqual(names);
  });
}

async function ready() {
  await waitFor(() => {
    return expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

test("Reopening preserves native strip order for blank and duplicate-URL tabs", async () => {
  const { browser, start } = viewer();
  await start();
  await ordered();
  await ready();
  cleanup();
  await waitFor(() => {
    return expect(browser.activeConnections()).toBe(0);
  });
  browser.shufflePageEnumeration(["second", "foreign", "first", "blank"]);
  await start();
  await ordered();
  await ready();

  click(screen.getByLabelText("Second", { selector: '[role="tab"]' }));
  await waitFor(() => {
    return expect(
      screen.getByLabelText("Second", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  await ready();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "second page input" },
    inputType: "insertText",
  });
  await waitFor(() => {
    return expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "second page input" },
        sessionId: browser.pageSession("second"),
      }),
    );
  });
});

test("A native move crossing an order read keeps the selected page usable and publishes fresh order", async () => {
  const { browser, start } = viewer();
  const held = browser.holdNext("tab-order");
  await start();
  await held.received;
  await ready();
  const selected = screen.getByLabelText("First", { selector: '[role="tab"]' });
  expect(selected).toHaveAttribute("aria-selected", "true");
  act(() => {
    return browser.reorder(101, ["second", "first", "blank"]);
  });
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  await act(held.release);
  await ordered(["Second", "First", "New tab"]);
  expect(selected).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Address")).toHaveValue("https://same.example/");
  await ready();
});

test("Paused native moves coalesce and resume without replacing the selection", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const { browser, start } = viewer();
  await start();
  await ordered();
  await ready();
  act(() => {
    return visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  const reads = browser.requests.filter((request) => {
    return request.method === "Target.getTargets";
  }).length;
  act(() => {
    browser.reorder(101, ["second", "first", "blank"]);
    browser.reorder(101, ["first", "blank", "second"]);
  });
  expect(
    browser.requests.filter((request) => {
      return request.method === "Target.getTargets";
    }),
  ).toHaveLength(reads);
  expect(tabNames()).toStrictEqual(["New tab", "Second", "First"]);
  const held = browser.holdNext("tab-order");
  act(() => {
    return visibility.changeTo("visible");
  });
  await held.received;
  await ready();
  expect(
    screen.getByLabelText("First", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  await act(held.release);
  await ordered(["First", "New tab", "Second"]);
});

test("A page moved out during an order read stays excluded after refresh", async () => {
  const { browser, start } = viewer();
  await start();
  await ordered();
  await ready();
  const held = browser.holdNext("tab-order");
  act(() => {
    return browser.reorder(101, ["first", "second", "blank"]);
  });
  await held.received;
  act(() => {
    return browser.move("second", 202);
  });
  await act(held.release);
  await ordered(["First", "New tab"]);
  await ready();
  expect(
    screen.getByLabelText("First", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
});

test("Pausing during a tab attachment releases its late receipt before resuming order discovery", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const { browser, start } = viewer();
  await start();
  await ordered();
  await ready();
  const held = browser.holdNext("Target.attachToTarget");
  act(() => {
    return browser.reorder(101, ["second", "blank", "first"]);
  });
  await held.received;
  act(() => {
    return visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  await act(held.release);
  const attached = browser.requests.filter((request) => {
    return (
      request.method === "Target.attachToTarget" &&
      request.params?.targetId?.startsWith("native-tab:")
    );
  });
  await waitFor(() => {
    return expect(
      browser.detached.filter((id) => {
        return id.startsWith("native-tab:");
      }),
    ).toHaveLength(attached.length);
  });
  act(() => {
    return visibility.changeTo("visible");
  });
  await ordered(["Second", "New tab", "First"]);
  await ready();
});

test.each(["initial", "later"])(
  "A new tab accepts input while the %s native order read is pending",
  async (phase) => {
    const { browser, start } = viewer();
    const held = phase === "initial" ? browser.holdNext("tab-order") : null;
    await start();
    if (!held) {
      await ordered();
    }
    await ready();
    const pending = held ?? browser.holdNext("tab-order");
    if (!held) {
      act(() => {
        return browser.reorder(101, ["blank", "second", "first"]);
      });
    }
    await pending.received;
    click(
      screen.getByLabelText("New tab", {
        selector: 'button:not([role="tab"])',
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveValue("");
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
      expect(
        queryAllByRoleFast("tab").filter((tab) => {
          return tab.getAttribute("aria-selected") === "true";
        }),
      ).toHaveLength(1);
    });
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    fireEvent.input(input, {
      target: { value: "input before native order completes" },
      inputType: "insertText",
    });
    await waitFor(() => {
      expect(browser.input).toContainEqual(
        expect.objectContaining({
          method: "Input.insertText",
          params: { text: "input before native order completes" },
          sessionId: browser.pageSession("created-1"),
        }),
      );
    });
    await act(pending.release);
    await ordered(["New tab", "Second", "First", "New tab"]);
    await ready();
  },
);
