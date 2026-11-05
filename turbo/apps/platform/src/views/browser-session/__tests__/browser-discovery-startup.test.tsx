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
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  recordBrowserStartupErrors,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockMonotonicNow, mockNow } from "../../../lib/time.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/discovery-startup";

function viewer() {
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  mockNow(() => {
    return Date.parse("2026-09-01T10:00:00.000Z") + elapsed;
  }, context.signal);
  const session: BrowserSession = {
    threadId,
    name: "booking",
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
    return respond(200, { browser: session });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, {
      browser: session,
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  const browser = mockBrowserCdp(context, endpoint, {
    targets: [
      {
        targetId: "own-first",
        title: "First own tab",
        url: "https://first.example.com",
        windowId: 101,
      },
      ...Array.from({ length: 20 }, (_, index) => {
        return {
          targetId: `sibling-${index}`,
          title: `Sibling ${index}`,
          url: `https://sibling-${index}.example.com`,
          windowId: 202,
        };
      }),
      {
        targetId: "own-later",
        title: "Later own tab",
        url: "https://later.example.com",
        windowId: 101,
      },
    ],
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
    advance(ms: number) {
      act(() => {
        elapsed += ms;
      });
    },
  };
}

async function ready(url = "https://first.example.com") {
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(url);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

test("A proven page accepts input before later sibling discovery settles", async () => {
  const { browser, start } = viewer();
  const held = browser.holdNextMembership("sibling-3");
  await start();
  await held.received;
  await ready();
  expect(screen.queryByLabelText("Later own tab")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Sibling 0")).not.toBeInTheDocument();

  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "first frame input" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "first frame input" },
      }),
    );
  });

  await act(held.release);
  const later = await screen.findByLabelText("Later own tab");
  expect(later).toBeInTheDocument();
  expect(screen.queryByLabelText("Sibling 19")).not.toBeInTheDocument();
  await ready();
});

test("Reconnect admits its preferred tab before the remaining inventory", async () => {
  const { browser, start, advance } = viewer();
  await start();
  const later = await screen.findByLabelText("Later own tab");
  click(later);
  await ready("https://later.example.com");

  const held = browser.holdNextMembership("sibling-3");
  act(() => {
    browser.disconnect({ code: 1006, reason: "temporary connection loss" });
  });
  await screen.findByText("Reconnecting…");
  advance(1000);
  await held.received;
  await ready("https://later.example.com");
  expect(
    screen.getByLabelText("Later own tab", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  await act(held.release);
  await ready("https://later.example.com");
});

test("Creating a tab during the continuing scan retains unvisited own tabs", async () => {
  const { browser, start } = viewer();
  const held = browser.holdNextMembership("sibling-3");
  await start();
  await held.received;
  await ready();
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await waitFor(() => {
    expect(browser.targets).toContainEqual(
      expect.objectContaining({ targetId: "created-1", windowId: 101 }),
    );
  });
  await act(held.release);
  const later = await screen.findByLabelText("Later own tab");
  expect(later).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.queryByLabelText("Sibling 19")).not.toBeInTheDocument();
});

test("A late membership reply cannot admit a tab moved to a sibling window", async () => {
  const { browser, start } = viewer();
  const held = browser.holdNextMembership("own-later");
  await start();
  await held.received;
  await ready();
  act(() => {
    browser.move("own-later", 202);
  });
  await act(held.release);
  await ready();
  expect(screen.queryByLabelText("Later own tab")).not.toBeInTheDocument();
});

test("A later discovery failure revokes the admitted viewer's input", async () => {
  recordBrowserStartupErrors();
  const { browser, start } = viewer();
  const held = browser.holdNextMembership("sibling-3");
  await start();
  await held.received;
  await ready();
  await act(async () => {
    await held.releaseFailure("Method not found", -32_601);
  });
  const failure = await screen.findByText(
    "The browser does not support this operation.",
  );
  expect(failure).toBeInTheDocument();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(screen.queryByLabelText("Later own tab")).not.toBeInTheDocument();
});

test("An in-flight selection survives later inventory publication", async () => {
  const { browser, start } = viewer();
  const scan = browser.holdNextMembership("sibling-3");
  const activation = browser.holdNext("Target.activateTarget");
  await start();
  await scan.received;
  await activation.received;
  await act(scan.release);
  const later = await screen.findByLabelText("Later own tab");
  expect(later).toBeInTheDocument();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(activation.release);
  await ready();
});

test("Unmounting an admitted viewer cancels its continuing discovery", async () => {
  const errors = recordBrowserStartupErrors();
  const { browser, start } = viewer();
  const held = browser.holdNextMembership("sibling-3");
  await start();
  await held.received;
  await ready();
  cleanup();
  await waitFor(() => {
    expect(browser.activeConnections()).toBe(0);
  });
  await act(held.release);
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();
  expect(errors).toHaveLength(0);
});
