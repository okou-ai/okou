import {
  browserContract,
  type BrowserSession,
  type BrowserTabOrder,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
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

function viewer(prefix = "", persisted = true) {
  const reports: BrowserTabOrder[] = [];
  const id = (value: string) => {
    return prefix + value;
  };
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
      instanceId: prefix
        ? "33333333-3333-4333-8333-333333333333"
        : "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 101,
    },
  };
  const endpoint = `wss://browser.example/tab-order-${prefix}`;
  const connection = {
    browser: session,
    cdpUrl: endpoint,
    extension: TEST_BROWSER_EXTENSION,
    tabOrder: persisted
      ? {
          instanceId: session.window!.instanceId,
          windowId: 101,
          // Even a saved hint never admits a foreign page.
          targetIds: ["blank", "foreign", "second", "first"].map(id),
        }
      : undefined,
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: session, viewer: connection });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, connection);
  });
  context.mocks.api(browserContract.leaseByThread, ({ body, respond }) => {
    if (body.tabOrder) {
      reports.push(body.tabOrder);
    }
    return respond(200, { browser: session });
  });
  const browser = mockBrowserCdp(context, endpoint, {
    targets: [
      {
        targetId: id("first"),
        title: "First",
        url: "https://same.example/",
        windowId: 101,
      },
      {
        targetId: id("second"),
        title: "Second",
        url: "https://same.example/",
        windowId: 101,
      },
      {
        targetId: id("blank"),
        title: "about:blank",
        url: "about:blank",
        windowId: 101,
      },
      {
        targetId: id("foreign"),
        title: "Foreign",
        url: "https://same.example/",
        windowId: 202,
      },
    ],
    nativeOrder: ["first", "second", "blank", "foreign"].map(id),
  });
  return {
    browser,
    reports,
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
function noOrderingScans(browser: ReturnType<typeof mockBrowserCdp>) {
  expect(
    browser.requests.filter((request) => {
      return request.method === "Target.setAutoAttach";
    }),
  ).toHaveLength(0);
  expect(
    browser.requests.filter((request) => {
      return (
        request.method === "Target.attachToTarget" &&
        String(request.params?.targetId).startsWith("native-tab:")
      );
    }),
  ).toHaveLength(0);
}

test("Reopening preserves saved order for blank and duplicate-URL tabs without native-order IO", async () => {
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
  noOrderingScans(browser);
});

test("Native strip movement does not redefine our order or replace the selected page", async () => {
  const { browser, start } = viewer();
  await start();
  await ordered();
  click(screen.getByLabelText("First", { selector: '[role="tab"]' }));
  await ready();
  act(() => {
    return browser.reorder(101, ["first", "blank", "second"]);
  });
  await ordered();
  expect(
    screen.getByLabelText("First", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  noOrderingScans(browser);
});

test("Pause and resume retain our order while native positions change", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const { browser, start } = viewer();
  await start();
  await ordered();
  await ready();
  act(() => {
    return visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  act(() => {
    browser.reorder(101, ["second", "first", "blank"]);
    browser.reorder(101, ["first", "blank", "second"]);
  });
  expect(tabNames()).toStrictEqual(["New tab", "Second", "First"]);
  act(() => {
    return visibility.changeTo("visible");
  });
  await ready();
  await ordered();
  noOrderingScans(browser);
});

test("A saved page moved to a sibling window remains excluded", async () => {
  const { browser, start } = viewer();
  await start();
  await ordered();
  await ready();
  act(() => {
    return browser.move("second", 202);
  });
  await ordered(["New tab", "First"]);
  expect(tabNames()).not.toContain("Second");
  await ready();
  noOrderingScans(browser);
});

test.each([1, 3])(
  "New tabs append and accept input without any order scan (%s creations)",
  async (count) => {
    const { browser, start } = viewer();
    await start();
    await ordered();
    await ready();
    for (let index = 1; index <= count; index++) {
      click(
        screen.getByLabelText("New tab", {
          selector: 'button:not([role="tab"])',
        }),
      );
      await ordered([
        "New tab",
        "Second",
        "First",
        ...Array.from({ length: index }, () => {
          return "New tab";
        }),
      ]);
      await ready();
    }
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    fireEvent.input(input, {
      target: { value: "new page input" },
      inputType: "insertText",
    });
    await waitFor(() => {
      return expect(browser.input).toContainEqual(
        expect.objectContaining({
          method: "Input.insertText",
          params: { text: "new page input" },
          sessionId: browser.pageSession(`created-${count}`),
        }),
      );
    });
    noOrderingScans(browser);
  },
);

test("Reconstructed page IDs use the saved positions rather than ID or CDP enumeration order", async () => {
  const original = viewer();
  await original.start();
  await ordered();
  cleanup();
  await waitFor(() => {
    return expect(original.browser.activeConnections()).toBe(0);
  });
  const restored = viewer("rebuilt-");
  restored.browser.shufflePageEnumeration([
    "rebuilt-second",
    "rebuilt-first",
    "rebuilt-foreign",
    "rebuilt-blank",
  ]);
  await restored.start();
  await ordered();
  await ready();
  noOrderingScans(restored.browser);
});

test("Immediate reopening retains a new tab before the server heartbeat publishes it", async () => {
  const { browser, start } = viewer();
  await start();
  await ordered();
  await ready();
  click(
    screen.getByLabelText("New tab", { selector: 'button:not([role="tab"])' }),
  );
  await ordered(["New tab", "Second", "First", "New tab"]);
  await ready();
  cleanup();
  await waitFor(() => {
    return expect(browser.activeConnections()).toBe(0);
  });
  browser.shufflePageEnumeration([
    "created-1",
    "first",
    "second",
    "blank",
    "foreign",
  ]);
  await start();
  await ordered(["New tab", "Second", "First", "New tab"]);
  await ready();
  noOrderingScans(browser);
});

test("Unavailable local storage cannot block new-tab creation or input", async () => {
  const { browser, start } = viewer();
  await start();
  await ordered();
  await ready();
  const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  try {
    click(
      screen.getByLabelText("New tab", {
        selector: 'button:not([role="tab"])',
      }),
    );
    await ordered(["New tab", "Second", "First", "New tab"]);
    expect(tabNames()).toHaveLength(4);
    await ready();
    noOrderingScans(browser);
  } finally {
    write.mockRestore();
  }
});

test("The existing heartbeat publishes our complete scoped order", async () => {
  const { browser, start, reports } = viewer();
  await start();
  await ordered();
  await ready();
  click(
    screen.getByLabelText("New tab", { selector: 'button:not([role="tab"])' }),
  );
  await ordered(["New tab", "Second", "First", "New tab"]);
  await ready();
  await waitFor(() => {
    return expect(reports).toContainEqual({
      instanceId: "22222222-2222-4222-8222-222222222222",
      windowId: 101,
      targetIds: ["blank", "second", "first", "created-1"],
    });
  });
  noOrderingScans(browser);
});

test("A preceding API response without order metadata still opens a usable viewer", async () => {
  const { browser, start } = viewer("", false);
  await start();
  await ordered(["First", "Second", "New tab"]);
  expect(tabNames()).toStrictEqual(["First", "Second", "New tab"]);
  await ready();
  noOrderingScans(browser);
});
