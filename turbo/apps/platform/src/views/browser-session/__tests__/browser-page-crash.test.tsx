import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { initSentry } from "../../../lib/sentry.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

function mockViewer(crashed = false) {
  const session: BrowserSession = {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: null,
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
  const cdpUrl = "wss://browser.example/page-crash";
  const browser = mockBrowserCdp(context, cdpUrl, {
    crashedTargets: crashed ? ["example-page"] : [],
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
        windowId: 0,
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: session,
      viewer: {
        browser: session,
        cdpUrl,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  return browser;
}

async function ready(url = "https://example.com") {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue(url);
  });
}

async function openViewer() {
  const browser = mockViewer();
  await setupPage({ context, path: `/browsers/${threadId}` });
  await ready();
  return browser;
}

async function unavailable() {
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(screen.getByLabelText("Address")).toBeEnabled();
  expect(screen.getByText("Reload", { selector: "button" })).toBeEnabled();
  expect(screen.getByText("Reconnect", { selector: "button" })).toBeEnabled();
}

async function navigateTo(url: string) {
  const address = screen.getByLabelText<HTMLInputElement>("Address");
  await fill(address, url);
  fireEvent.submit(address.form!);
  await ready(url);
}

test.each(["session", "target", "split frames"] as const)(
  "A retained page crash (%s) requires explicit reload and keeps its window connection",
  async (notification) => {
    const browser = await openViewer();
    if (notification === "split frames") {
      click(screen.getByLabelText("Browser settings"));
      click(await screen.findByText("Connection mode"));
      click(await screen.findByText("Separate image connection"));
      await ready();
    }
    const connections = browser.connections();
    const original = browser.pageSession("example-page");
    const frameSession = [...browser.requests].reverse().find((request) => {
      return request.method === "Page.startScreencast";
    })!.sessionId!;
    act(() => {
      if (notification === "split frames") {
        browser.crash("example-page", "none");
        browser.event("Inspector.targetCrashed", {}, frameSession);
      } else {
        browser.crash("example-page", notification);
      }
    });
    await unavailable();
    expect(browser.targets).toHaveLength(2);
    expect(
      browser.requests.filter((request) => {
        return request.method === "Page.reload";
      }),
    ).toHaveLength(0);
    // A queued frame cannot revive the retired crashed session.
    act(() => {
      browser.event(
        "Page.screencastFrame",
        {
          sessionId: 7,
          data: "AAAA",
          metadata: {
            timestamp: 4,
            offsetTop: 0,
            pageScaleFactor: 1,
            deviceWidth: 1440,
            deviceHeight: 900,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
          },
        },
        frameSession,
      );
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    click(screen.getByText("Reload", { selector: "button" }));
    await ready();
    expect(browser.connections()).toBe(connections);
    expect(
      browser.requests.filter((request) => {
        return request.method === "Page.reload";
      }),
    ).toHaveLength(1);
    expect(browser.pageSession("example-page")).not.toBe(original);

    // A late target-ID event must obtain current-session evidence, rather than
    // treating the original crash as authority over the healthy successor.
    const confirmation = browser.holdNext("Inspector.enable");
    act(() => {
      browser.event("Inspector.targetCrashed", {}, original);
      browser.event("Target.targetCrashed", {
        targetId: "example-page",
        status: "crashed",
        errorCode: 5,
      });
    });
    await act(async () => {
      await confirmation.release();
    });
    await navigateTo("https://recovered.example/fresh");
  },
);

test("A page already crashed at attachment admission remains reloadable without retiring the connection", async () => {
  const browser = mockViewer(true);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await unavailable();
  click(screen.getByText("Reload", { selector: "button" }));
  await ready();
  expect(browser.connections()).toBe(1);
  await navigateTo("https://initial-recovery.example/");
});

test("A crash while page initialization is pending cancels its reads and exposes recovery", async () => {
  const browser = mockViewer();
  const initializing = browser.holdNext("Page.getFrameTree");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await initializing.received;
  act(() => {
    browser.crash("example-page");
  });
  await unavailable();
  click(screen.getByText("Reload", { selector: "button" }));
  await ready();
  await act(async () => {
    await initializing.release();
  });
  await navigateTo("https://initialized-recovery.example/");
  expect(browser.connections()).toBe(1);
});

test("An unrelated page or session crash leaves the selected page usable", async () => {
  const browser = await openViewer();
  act(() => {
    browser.crash("other-page");
    browser.event("Inspector.targetCrashed", {}, "unrelated-session");
  });
  await navigateTo("https://selected-survivor.example/");
  expect(browser.connections()).toBe(1);
});

test("A crash waits for the original input receipt before the user's reload and never replays text", async () => {
  const browser = await openViewer();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  const receipt = browser.holdNext("Input.insertText");
  fireEvent.input(input, {
    target: { value: "original text" },
    inputType: "insertText",
  });
  await receipt.received;
  act(() => {
    browser.crash("example-page");
  });
  await unavailable();
  click(screen.getByText("Reload", { selector: "button" }));
  await waitFor(() => {
    expect(screen.getByText("Reload", { selector: "button" })).toBeDisabled();
  });
  expect(
    browser.requests.filter((request) => {
      return request.method === "Page.reload";
    }),
  ).toHaveLength(0);
  await act(async () => {
    await receipt.release();
  });
  await ready();
  expect(
    browser.input.filter((entry) => {
      return entry.method === "Input.insertText";
    }),
  ).toStrictEqual([
    {
      method: "Input.insertText",
      params: { text: "original text" },
      sessionId: "example-page-session",
    },
  ]);
  expect(
    browser.requests.filter((request) => {
      return request.method === "Page.reload";
    }),
  ).toHaveLength(1);
});

test("A failed original input receipt still fences the crashed tab while a healthy sibling works", async () => {
  context.mocks.sentry();
  initSentry();
  const browser = await openViewer();
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  browser.failNext("Input.insertText", "Original input outcome unconfirmed");
  const receipt = browser.holdNext("Input.insertText");
  fireEvent.input(screen.getByLabelText("Remote browser input"), {
    target: { value: "uncertain text" },
    inputType: "insertText",
  });
  await receipt.received;
  act(() => {
    browser.crash("example-page");
  });
  await unavailable();
  await act(async () => {
    await receipt.release();
  });
  click(screen.getByText("Reload", { selector: "button" }));
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  expect(
    browser.requests.filter((request) => {
      return request.method === "Page.reload";
    }),
  ).toHaveLength(0);
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await ready("https://other.example.com");
  await navigateTo("https://healthy-sibling.example/");
  expect(
    screen.queryByText(
      "The browser action could not be completed. Check the browser before trying again.",
    ),
  ).toBeNull();
  expect(browser.connections()).toBe(1);
});

test("A crash cannot substitute for a missing capture-stop or detachment receipt", async () => {
  const browser = await openViewer();
  const detached = browser.holdNextDetach("example-page-session");
  browser.failNext("Page.stopScreencast", "Capture stop unconfirmed");
  act(() => {
    browser.crash("example-page");
  });
  await unavailable();
  await detached.received;
  click(screen.getByText("Reload", { selector: "button" }));
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  expect(
    browser.requests.filter((request) => {
      return request.method === "Page.reload";
    }),
  ).toHaveLength(0);
  await act(async () => {
    await detached.release();
  });
  click(screen.getByText("Reload", { selector: "button" }));
  await ready();
  await navigateTo("https://confirmed-capture.example/");
});

test.each(["Target.attachToTarget", "Page.reload"])(
  "Changing tabs during crash recovery (%s) preserves the successor and does not replay reload",
  async (method) => {
    const browser = await openViewer();
    act(() => {
      browser.crash("example-page");
    });
    await unavailable();
    const receipt = browser.holdNext(method);
    click(screen.getByText("Reload", { selector: "button" }));
    await receipt.received;
    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await ready("https://other.example.com");
    await act(async () => {
      await receipt.release();
    });
    await navigateTo("https://successor.example/");
    expect(
      browser.requests.filter((request) => {
        return request.method === "Page.reload";
      }),
    ).toHaveLength(method === "Page.reload" ? 1 : 0);
    expect(browser.connections()).toBe(1);
  },
);

test("A rejected reload stays unavailable without carrying its error into another crashed tab", async () => {
  const browser = await openViewer();
  act(() => {
    browser.crash("example-page");
  });
  await unavailable();
  browser.failNext("Page.reload", "Renderer could not reload");
  click(screen.getByText("Reload", { selector: "button" }));
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    browser.requests.filter((request) => {
      return request.method === "Page.reload";
    }),
  ).toHaveLength(1);
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await ready("https://other.example.com");
  act(() => {
    browser.crash("other-page");
  });
  await unavailable();
  expect(
    screen.queryByText(
      "The browser action could not be completed. Check the browser before trying again.",
    ),
  ).toBeNull();
  click(screen.getByText("Reload", { selector: "button" }));
  await ready("https://other.example.com");
  await navigateTo("https://sibling-crash-recovery.example/");
});

test("Hiding the viewer cancels a pending crash reload even if visibility returns before its reply", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await openViewer();
  act(() => {
    browser.crash("example-page");
  });
  await unavailable();
  const attachment = browser.holdNext("Target.attachToTarget");
  click(screen.getByText("Reload", { selector: "button" }));
  await attachment.received;
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  act(() => {
    visibility.changeTo("visible");
  });
  await screen.findByText("Browser view unavailable");
  await act(async () => {
    await attachment.release();
  });
  await unavailable();
  expect(
    browser.requests.filter((request) => {
      return request.method === "Page.reload";
    }),
  ).toHaveLength(0);
  click(screen.getByText("Reload", { selector: "button" }));
  await ready();
  expect(browser.connections()).toBe(1);
});

test("Closing a sibling tab preserves the selected crashed page's Reload action", async () => {
  const browser = await openViewer();
  act(() => {
    browser.crash("example-page");
  });
  await unavailable();
  const closing = browser.holdNext("Target.closeTarget");
  click(screen.getByLabelText("Close Other"));
  await act(async () => {
    await closing.release();
  });
  expect(
    screen.queryByLabelText("Other", { selector: '[role="tab"]' }),
  ).toBeNull();
  await unavailable();
  click(screen.getByText("Reload", { selector: "button" }));
  await ready();
  await navigateTo("https://sibling-close-recovery.example/");
  expect(browser.connections()).toBe(1);
});

test("A renderer crash during a rejected tab close remains unavailable until explicit recovery", async () => {
  const browser = await openViewer();
  browser.failNext(
    "Target.closeTarget",
    "The browser could not close the page",
  );
  const closing = browser.holdNext("Target.closeTarget");
  click(screen.getByLabelText("Close Example"));
  await closing.received;
  act(() => {
    browser.crash("example-page");
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(async () => {
    await closing.release();
  });
  await unavailable();
  click(screen.getByText("Reload", { selector: "button" }));
  await ready();
  await navigateTo("https://close-failure-recovery.example/");
  expect(browser.connections()).toBe(1);
});
