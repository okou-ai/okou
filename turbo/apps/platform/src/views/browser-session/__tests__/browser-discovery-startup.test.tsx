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
    start(enabled = true) {
      return setupPage({
        context,
        path: `/browsers/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.BrowserSharedOwner]: enabled },
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

test("A background creation readmits the selected page before the remaining tab proof", async () => {
  const { browser, start } = viewer();
  await start();
  await screen.findByLabelText("Later own tab");
  await ready();

  const selected = browser.holdNextMembership("own-first");
  const background = browser.holdNextMembership("background");
  act(() => {
    const target = {
      targetId: "background",
      title: "Background",
      url: "https://background.example.com",
      windowId: 101,
    };
    browser.targets.push(target);
    browser.nativeEvent("tab-created", target);
    browser.event("Target.targetCreated", {
      targetInfo: { ...target, type: "page" },
    });
  });
  await selected.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(selected.release);
  await background.received;
  await ready();

  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "during background discovery" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "during background discovery" },
      }),
    );
  });
  await act(background.release);
  await screen.findByLabelText("Background", { selector: '[role="tab"]' });
  await ready();
});

test("A tab selected during background discovery becomes ready after its proof", async () => {
  const { browser, start } = viewer();
  await start();
  await screen.findByLabelText("Later own tab");
  await ready();

  const proof = browser.holdNextMembership("own-later");
  act(() => {
    const target = {
      targetId: "background",
      title: "Background",
      url: "https://background.example.com",
      windowId: 101,
    };
    browser.targets.push(target);
    browser.nativeEvent("tab-created", target);
    browser.event("Target.targetCreated", {
      targetInfo: { ...target, type: "page" },
    });
  });
  await proof.received;
  await ready();
  await userEvent.click(
    screen.getByLabelText("Later own tab", { selector: '[role="tab"]' }),
  );
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(proof.release);
  await ready("https://later.example.com");

  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "new selection after proof" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        sessionId: browser.pageSession("own-later"),
        params: { text: "new selection after proof" },
      }),
    );
  });
});

test("Background removal readmits the selected page without disturbing navigation", async () => {
  const { browser, start } = viewer();
  await start();
  await screen.findByLabelText("Later own tab");
  await ready();

  const proof = browser.holdNextMembership("own-first");
  act(() => {
    const removed = browser.targets.splice(-1, 1)[0]!;
    browser.event("Target.targetDestroyed", { targetId: removed.targetId });
    browser.nativeEvent("tab-removed", removed);
  });
  await proof.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(proof.release);
  await ready();
  expect(screen.queryByLabelText("Later own tab")).not.toBeInTheDocument();
  const address = screen.getByLabelText("Address");
  await userEvent.click(address);
  await userEvent.keyboard(
    "{Control>}a{/Control}after-removal.example/ready{Enter}",
  );
  await ready("http://after-removal.example/ready");
  expect(browser.targets[0]?.url).toBe("http://after-removal.example/ready");
});

test("A move supersedes a held narrow refresh and cannot be downgraded by another creation", async () => {
  const { browser, start } = viewer();
  await start();
  await screen.findByLabelText("Later own tab");
  await ready();

  const stale = browser.holdNextMembership("own-first");
  act(() => {
    browser.duplicate("own-later");
  });
  await stale.received;
  act(() => {
    browser.move("own-first", 202);
    browser.move("sibling-0", 101);
    browser.duplicate("own-later");
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(stale.release);
  await screen.findByLabelText("Sibling 0", { selector: '[role="tab"]' });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.queryByLabelText("First own tab")).not.toBeInTheDocument();
  click(screen.getByLabelText("Sibling 0", { selector: '[role="tab"]' }));
  await ready("https://sibling-0.example.com");
});

test("Closing during a narrow refresh waits for the background survivor proof", async () => {
  const { browser, start } = viewer();
  browser.targets.pop();
  await start();
  await ready();

  const background = browser.holdNextMembership("background");
  act(() => {
    const target = {
      targetId: "background",
      title: "Background survivor",
      url: "https://survivor.example.com",
      windowId: 101,
    };
    browser.targets.push(target);
    browser.nativeEvent("tab-created", target);
    browser.event("Target.targetCreated", {
      targetInfo: { ...target, type: "page" },
    });
  });
  await background.received;
  await ready();
  click(screen.getByLabelText("Close First own tab"));
  await act(background.release);
  await ready("https://survivor.example.com");
  expect(screen.queryByLabelText("First own tab")).not.toBeInTheDocument();
  expect(
    browser.targets.filter((target) => {
      return target.windowId === 101;
    }),
  ).toStrictEqual([expect.objectContaining({ targetId: "background" })]);
});

test("A background lookup failure is rechecked after a non-moving tab event", async () => {
  const { browser, start } = viewer();
  const failed = browser.holdNextMembership("own-later");
  await start();
  await failed.received;
  await act(failed.releaseFailure);
  await ready();
  expect(screen.queryByLabelText("Later own tab")).not.toBeInTheDocument();
  act(() => {
    browser.nativeEvent("tab-created", undefined, {
      tabId: 100,
      windowId: 101,
    });
  });
  await screen.findByLabelText("Later own tab");
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

test("A pending creation does not hide an initially unvisited survivor from close preservation", async () => {
  const { browser, start } = viewer();
  const scan = browser.holdNextMembership("sibling-3");
  await start();
  await scan.received;
  await ready();
  const creation = browser.holdNextNative("createTab");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await creation.received;
  click(screen.getByLabelText("Close First own tab"));
  await act(scan.release);
  await waitFor(() => {
    expect(
      screen.queryByLabelText("First own tab", { selector: '[role="tab"]' }),
    ).not.toBeInTheDocument();
  });
  expect(
    browser.targets.some((target) => {
      return target.targetId === "created-2";
    }),
  ).toBeFalsy();
  await act(creation.release);
  await ready("https://later.example.com");
});

test.each([true, false])(
  "Losing the first proven tab waits for a complete inventory (survivor: %s)",
  async (survivor) => {
    const { browser, start } = viewer();
    const held = browser.holdNextMembership("sibling-3");
    await start();
    await held.received;
    await ready();
    act(() => {
      if (!survivor) {
        browser.event("Target.targetDestroyed", { targetId: "own-later" });
      }
      browser.event("Target.targetDestroyed", { targetId: "own-first" });
    });
    await screen.findByText("Connecting to browser…");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
    await act(held.release);
    if (survivor) {
      await ready("https://later.example.com");
    } else {
      await screen.findByText("No tabs open");
      click(screen.getByLabelText("New tab", { selector: "button" }));
      await ready("");
    }
    expect(
      screen.getByLabelText(survivor ? "Later own tab" : "New tab", {
        selector: '[role="tab"]',
      }),
    ).toHaveAttribute("aria-selected", "true");
  },
);

test.each([true, false])(
  "A newly observed page prevents an empty conclusion until its proof settles (owned: %s)",
  async (owned) => {
    const { browser, start } = viewer();
    await start();
    await ready();
    await screen.findByLabelText("Later own tab");
    const target = {
      targetId: "new-page",
      title: "New page",
      url: "https://new.example.com",
      windowId: owned ? 101 : 202,
    };
    browser.targets.push(target);
    const held = browser.holdNextMembership(target.targetId);
    act(() => {
      browser.event("Target.targetCreated", {
        targetInfo: { ...target, type: "page" },
      });
    });
    await held.received;
    act(() => {
      browser.event("Target.targetDestroyed", { targetId: "own-later" });
      browser.event("Target.targetDestroyed", { targetId: "own-first" });
    });
    await screen.findByText("Connecting to browser…");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
    await act(held.release);
    if (owned) {
      await ready(target.url);
    } else {
      await screen.findByText("No tabs open");
      click(screen.getByLabelText("New tab", { selector: "button" }));
      await ready("");
    }
  },
);

test("Closing the initially visible tab preserves the undiscovered survivor without an extra blank tab", async () => {
  const { browser, start } = viewer();
  const held = browser.holdNextMembership("sibling-3");
  await start();
  await held.received;
  await ready();
  click(screen.getByLabelText("Close First own tab"));
  await act(held.release);
  await ready("https://later.example.com");
  expect(
    screen.queryByLabelText("New tab", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
  expect(
    browser.targets.filter((target) => {
      return target.windowId === 101;
    }),
  ).toMatchObject([{ targetId: "own-later" }]);
});

test("A close revalidates a failed partial inventory before counting survivors", async () => {
  recordBrowserStartupErrors();
  const { browser, start } = viewer();
  const held = browser.holdNextMembership("sibling-3");
  await start(false);
  await held.received;
  await ready();
  browser.failNext("Runtime.evaluate", "Native window temporarily unavailable");
  act(() => {
    browser.nativeEvent("tab-attached", browser.targets[0]);
  });
  await act(held.release);
  await screen.findByText("Browser view unavailable");
  const close = screen.getByLabelText("Close First own tab");
  expect(close).toBeEnabled();
  click(close);
  await ready("https://later.example.com");
  expect(
    screen.queryByLabelText("New tab", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
});

test.each([true, false])(
  "Overlapping closes during discovery preserve one tab (undiscovered survivor: %s)",
  async (survivor) => {
    const { browser, start } = viewer();
    browser.move("sibling-0", 101);
    if (!survivor) {
      const later = browser.targets.findIndex((target) => {
        return target.targetId === "own-later";
      });
      browser.targets.splice(later, 1);
    }
    const held = browser.holdNextMembership("sibling-3");
    await start();
    await held.received;
    await ready();
    click(screen.getByLabelText("Close First own tab"));
    click(screen.getByLabelText("Close Sibling 0"));
    await act(held.release);
    await ready(survivor ? "https://later.example.com" : "");
    expect(
      browser.targets.filter((target) => {
        return target.windowId === 101;
      }),
    ).toMatchObject([
      survivor ? { targetId: "own-later" } : { url: "about:blank" },
    ]);
  },
);

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

test("Unmounting cancels discovery and a close waiting for its inventory", async () => {
  const errors = recordBrowserStartupErrors();
  const { browser, start } = viewer();
  const held = browser.holdNextMembership("sibling-3");
  await start();
  await held.received;
  await ready();
  click(screen.getByLabelText("Close First own tab"));
  expect(screen.getByLabelText("Close First own tab")).toBeDisabled();
  cleanup();
  await waitFor(() => {
    expect(browser.activeConnections()).toBe(0);
  });
  await act(held.release);
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();
  expect(
    browser.targets.filter((target) => {
      return target.windowId === 101;
    }),
  ).toMatchObject([{ targetId: "own-first" }, { targetId: "own-later" }]);
  expect(errors).toHaveLength(0);
});
