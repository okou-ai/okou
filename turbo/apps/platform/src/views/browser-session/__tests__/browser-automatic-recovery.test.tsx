import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { HttpResponse } from "msw";
import {
  mockBrowserCdp,
  recordBrowserStartupErrors,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockMonotonicNow, mockNow } from "../../../lib/time.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const nextThreadId = "44444444-4444-4444-8444-444444444444";
const endpoint = "wss://browser.example/automatic?token=private";

function mockViewer() {
  let elapsed = 0;
  const now = Date.parse("2026-09-01T10:00:00Z");
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  mockNow(() => {
    return now + elapsed;
  }, context.signal);
  recordBrowserStartupErrors();
  const browser = mockBrowserCdp(context, endpoint, {
    targets: [
      {
        targetId: "example-page",
        title: "Original",
        url: "https://original.example",
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
  let windowId = 101;
  function session(id = threadId): BrowserSession {
    return {
      threadId: id,
      name: "automatic recovery",
      status: "active",
      viewerUrl: `https://viewer.example/browsers/${id}`,
      liveUrl: null,
      screenshotUrl: null,
      proxyCountryCode: null,
      timeoutMinutes: 10,
      idleExpiresAt: new Date(now + elapsed + 600_000).toISOString(),
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      window: {
        instanceId: "22222222-2222-4222-8222-222222222222",
        primaryWindowId: id === nextThreadId ? 202 : windowId,
      },
    };
  }
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    return respond(200, { browser: session(params.threadId) });
  });
  context.mocks.api(browserContract.viewerConnection, ({ params, respond }) => {
    return respond(200, {
      browser: session(params.threadId),
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    return respond(200, { browser: session(params.threadId) });
  });
  return {
    browser,
    session,
    start(enabled = true) {
      return setupPage({
        context,
        path: `/browsers/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.BrowserViewerRecovery]: enabled },
      });
    },
    advance(ms: number) {
      act(() => {
        elapsed += ms;
      });
    },
    replaceBinding() {
      windowId = 202;
    },
  };
}

async function ready(url = "https://original.example") {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue(url);
  });
}

function reconnect() {
  const button = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Reconnect";
  });
  if (!button) {
    throw new Error("Expected Reconnect");
  }
  return button;
}

async function pendingRecovery(label = "Reconnect") {
  const button = await screen.findByText(label, { selector: "button" });
  await waitFor(() => {
    expect(button).toBeDisabled();
  });
  return button;
}

async function insertText(text: string) {
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, { target: { value: text }, inputType: "insertText" });
}

async function splitConnection() {
  click(screen.getByLabelText("Browser settings"));
  const settings = await screen.findByRole("menu", {
    name: "Browser settings",
  });
  click(within(settings).getByText("Connection mode"));
  const mode = await screen.findByRole("menu", { name: "Connection mode" });
  click(within(mode).getByText("Separate image connection"));
  await ready();
}

test("Automatic connection recovery survives transient descriptors and restores the selected scoped tab", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await ready("https://other.example");
  let reads = 0;
  const replies = Array.from({ length: 3 }, () => {
    return context.mocks.deferred<void>();
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    replies[reads++]?.resolve();
    return reads < 3
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: `Transient descriptor ${reads}`,
          },
        })
      : respond(200, {
          browser: viewer.session(),
          cdpUrl: endpoint,
          extension: TEST_BROWSER_EXTENSION,
        });
  });
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  for (const [index, interval] of [1000, 2000, 4000].entries()) {
    viewer.advance(interval);
    await act(async () => {
      await replies[index]!.promise;
    });
  }
  await ready("https://other.example");
  await insertText("recovered selection");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("other"),
      params: { text: "recovered selection" },
    });
  });
  expect(reads).toBe(3);
  expect(
    screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
});

test.each(["shared", "split"] as const)(
  "Automatic %s image recovery retains healthy control",
  async (transport) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    if (transport === "split") {
      await splitConnection();
    }
    const connections = viewer.browser.connections();
    act(() => {
      viewer.browser.frame("!");
    });
    await pendingRecovery("Retry live image");
    viewer.advance(1000);
    await ready();
    await insertText("after image recovery");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "after image recovery" },
      });
    });
    expect(viewer.browser.connections()).toBe(connections);
  },
);

test("Exhausted automatic recovery stops after three attempts and permits a fresh manual operation", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  let reads = 0;
  let unavailable = true;
  const replies = Array.from({ length: 3 }, () => {
    return context.mocks.deferred<void>();
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    replies[reads++]?.resolve();
    return unavailable
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: `Unavailable ${reads}`,
          },
        })
      : respond(200, {
          browser: viewer.session(),
          cdpUrl: endpoint,
          extension: TEST_BROWSER_EXTENSION,
        });
  });
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  for (const [index, interval] of [1000, 2000, 4000].entries()) {
    viewer.advance(interval);
    await act(async () => {
      await replies[index]!.promise;
    });
  }
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  unavailable = false;
  viewer.advance(61_000);
  click(reconnect());
  await ready();
  expect(reads).toBe(4);
});

test.each([403, 409] as const)(
  "HTTP %s is terminal until an explicit recovery action",
  async (status) => {
    const viewer = mockViewer();
    let denied = true;
    let reads = 0;
    context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
      reads++;
      return denied
        ? respond(status, {
            error: {
              code: status === 403 ? "FORBIDDEN" : "CONFLICT",
              message: "Binding unavailable",
            },
          })
        : respond(200, {
            browser: viewer.session(),
            cdpUrl: endpoint,
            extension: TEST_BROWSER_EXTENSION,
          });
    });
    await viewer.start();
    await screen.findByText("Browser view unavailable");
    await waitFor(() => {
      expect(reconnect()).toBeEnabled();
    });
    viewer.advance(180_000);
    denied = false;
    click(reconnect());
    await ready();
    expect(reads).toBe(2);
  },
);

test("A disabled recovery switch retains manual recovery", async () => {
  const viewer = mockViewer();
  await viewer.start(false);
  await ready();
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await screen.findByText("Browser disconnected");
  expect(reconnect()).toBeEnabled();
  viewer.advance(180_000);
  click(reconnect());
  await ready();
  expect(viewer.browser.connections()).toBe(2);
});

test("The episode ceiling ends a stalled descriptor and late work cannot start another budget", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const received = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let reads = 0;
  context.mocks.api(browserContract.viewerConnection, async ({ respond }) => {
    reads++;
    if (reads === 1) {
      received.resolve();
      await release.promise;
    }
    return respond(200, {
      browser: viewer.session(),
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  viewer.advance(1000);
  await act(async () => {
    await received.promise;
  });
  viewer.advance(180_000);
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  await act(() => {
    release.resolve();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(reconnect());
  await ready();
  expect(reads).toBe(2);
});

test("Missing initial paint recovers automatically and rejects the retired first image", async () => {
  const viewer = mockViewer();
  const original = viewer.browser.holdFrames("example-page-session");
  await viewer.start();
  await act(async () => {
    await original.received;
  });
  viewer.advance(31_000);
  await pendingRecovery();
  viewer.advance(1000);
  await ready();
  act(() => {
    original.release();
  });
  await insertText("after first image recovery");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("example-page"),
      params: { text: "after first image recovery" },
    });
  });
});

test("A split image socket is replaced without replacing its healthy control socket", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  await splitConnection();
  const connections = viewer.browser.connections();
  await insertText("before image socket loss");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)?.method).toBe("Input.insertText");
  });
  const control = viewer.browser.requests.find((request) => {
    return request.method === "Input.insertText";
  })!.connectionId;
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false }, 1);
  });
  await pendingRecovery("Retry live image");
  viewer.advance(1000);
  await ready();
  await insertText("after image socket loss");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "after image socket loss" },
    });
  });
  expect(
    viewer.browser.requests
      .filter((request) => {
        return request.method === "Input.insertText";
      })
      .at(-1)?.connectionId,
  ).toBe(control);
  expect(viewer.browser.connections()).toBe(connections + 1);
});

test("Manual recovery serializes its transient failures with automatic policy", async () => {
  const viewer = mockViewer();
  let phase: "denied" | "temporary" | "ready" = "denied";
  let reads = 0;
  const temporary = context.mocks.deferred<void>();
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    reads++;
    if (phase === "denied") {
      return respond(403, { error: { code: "FORBIDDEN", message: "Denied" } });
    }
    if (phase === "temporary") {
      phase = "ready";
      temporary.resolve();
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Temporarily unavailable",
        },
      });
    }
    return respond(200, {
      browser: viewer.session(),
      cdpUrl: endpoint,
      extension: TEST_BROWSER_EXTENSION,
    });
  });
  await viewer.start();
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  phase = "temporary";
  click(reconnect());
  await act(async () => {
    await temporary.promise;
  });
  expect(reconnect()).toBeDisabled();
  viewer.advance(2000);
  await ready();
  expect(reads).toBe(3);
});

test("Pausing cancels recovery pacing and resuming recovers the current owner", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  viewer.advance(61_000);
  expect(viewer.browser.connections()).toBe(1);
  act(() => {
    visibility.changeTo("visible");
  });
  await screen.findByText("Connecting to browser…");
  viewer.advance(1000);
  await ready();
  await insertText("after resume");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)?.params).toMatchObject({
      text: "after resume",
    });
  });
});

test("Selecting another tab cancels held automatic image recovery and old pixels", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery("Retry live image");
  const image = viewer.browser.holdTargetFrames("example-page");
  viewer.advance(1000);
  await act(async () => {
    await image.received;
  });
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await ready("https://other.example");
  act(() => {
    image.release();
  });
  viewer.advance(180_000);
  await insertText("new selection survives");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("other"),
      params: { text: "new selection survives" },
    });
  });
});

test.each(["binding", "chat"] as const)(
  "A %s replacement cancels a held automatic bootstrap",
  async (replacement) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    const attachment = viewer.browser.holdNext("Target.attachToTarget");
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await pendingRecovery();
    viewer.advance(1000);
    await act(async () => {
      await attachment.received;
    });
    act(() => {
      if (replacement === "binding") {
        viewer.replaceBinding();
        context.mocks.ably.trigger("browserSessionChanged", { threadId });
      } else {
        window.history.pushState(null, "", `/browsers/${nextThreadId}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    });
    await ready("https://sibling.example");
    await act(async () => {
      await attachment.release();
    });
    viewer.advance(180_000);
    await insertText("replacement survives");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        sessionId: viewer.browser.pageSession("sibling"),
        params: { text: "replacement survives" },
      });
    });
  },
);

test.each(["input", "navigation", "creation"] as const)(
  "Automatic recovery never replays uncertain %s",
  async (effect) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    const receipt =
      effect === "creation"
        ? viewer.browser.holdNextNative("createTab")
        : viewer.browser.holdNext(
            effect === "input" ? "Input.insertText" : "Page.navigate",
          );
    if (effect === "input") {
      await insertText("only once");
    } else if (effect === "navigation") {
      await fill(screen.getByLabelText("Address"), "next.example");
      await userEvent.keyboard("{Enter}");
    } else {
      click(screen.getByLabelText("New tab", { selector: "button" }));
    }
    await receipt.received;
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await pendingRecovery();
    viewer.advance(1000);
    await ready(
      effect === "navigation"
        ? "http://next.example/"
        : "https://original.example",
    );
    await act(async () => {
      await receipt.release();
    });
    await insertText("fresh input");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "fresh input" },
      });
    });
    const effectCounts = {
      input: viewer.browser.input.filter((input) => {
        return input.method === "Input.insertText";
      }).length,
      navigation: viewer.browser.requests.filter((request) => {
        return request.method === "Page.navigate";
      }).length,
      creation: viewer.browser.targets.filter((target) => {
        return target.targetId.startsWith("created-");
      }).length,
    };
    expect(effectCounts[effect]).toBe(effect === "input" ? 2 : 1);
  },
);

test("Unsupported capability loss is terminal rather than an automatic retry", async () => {
  const viewer = mockViewer();
  viewer.browser.failNext("Page.enable", "Unavailable method", -32_601);
  await viewer.start();
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  viewer.advance(180_000);
  click(reconnect());
  await ready();
  expect(viewer.browser.connections()).toBe(2);
});

test("A reclaimed window cannot recover by using the sibling window", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.targets.splice(0, 2);
    viewer.browser.nativeEvent("window-removed", undefined, { windowId: 101 });
  });
  await screen.findByText("Browser disconnected");
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  viewer.advance(180_000);
  act(() => {
    window.history.pushState(null, "", `/browsers/${nextThreadId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await ready("https://sibling.example");
  expect(viewer.browser.connections()).toBe(2);
  expect(viewer.browser.targets).toHaveLength(1);
});

test("A healthy static viewer survives a failed HTTP heartbeat without reconnecting", async () => {
  const viewer = mockViewer();
  const failures: unknown[] = [];
  const error = vi.spyOn(console, "error");
  const unexpected = error.getMockImplementation();
  if (!unexpected) {
    throw new Error("Expected the shared error guard");
  }
  error.mockImplementation((...args: unknown[]) => {
    if (args[0] === "[E][BrowserHeartbeat]") {
      failures.push(args[2]);
      return;
    }
    unexpected(...args);
  });
  let failed = false;
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    if (!failed) {
      failed = true;
      return respond(503, {
        error: {
          code: "BROWSER_USE_SHARED_OPERATION_FAILED",
          message: "Temporary lease failure",
        },
      });
    }
    return respond(200, { browser: viewer.session() });
  });
  await viewer.start();
  await ready();
  await waitFor(() => {
    expect(failures).toHaveLength(1);
  });
  viewer.advance(61_000);
  await insertText("static content still works");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)?.params).toMatchObject({
      text: "static content still works",
    });
  });
  expect(viewer.browser.connections()).toBe(1);
});

test("A transient native read recovers the selected tab on the existing control connection", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await ready("https://other.example");
  const connections = viewer.browser.connections();
  viewer.browser.failNext(
    "Runtime.evaluate",
    "Native window temporarily unavailable",
  );
  act(() => {
    viewer.browser.nativeEvent("tab-attached", viewer.browser.targets[0]);
  });
  await pendingRecovery();
  viewer.advance(1000);
  await ready("https://other.example");
  await insertText("after native read");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("other"),
      params: { text: "after native read" },
    });
  });
  expect(viewer.browser.connections()).toBe(connections);
});

test.each(["network", "http-503"] as const)(
  "A transient %s descriptor failure permits the next recovery attempt",
  async (kind) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    const failed = context.mocks.deferred<void>();
    let unavailable = true;
    if (kind === "network") {
      context.mocks.http.get(
        `*/api/chat-threads/${threadId}/browser/viewer-connection`,
        () => {
          if (!unavailable) {
            return;
          }
          unavailable = false;
          failed.resolve();
          return HttpResponse.error();
        },
      );
    } else {
      context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
        if (unavailable) {
          unavailable = false;
          failed.resolve();
          return respond(503, {
            error: {
              code: "BROWSER_USE_SHARED_OPERATION_FAILED",
              message: "Temporarily unavailable",
            },
          });
        }
        return respond(200, {
          browser: viewer.session(),
          cdpUrl: endpoint,
          extension: TEST_BROWSER_EXTENSION,
        });
      });
    }
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await pendingRecovery();
    viewer.advance(1000);
    await act(async () => {
      await failed.promise;
    });
    await screen.findByText("Browser view unavailable");
    viewer.advance(2000);
    await ready();
    expect(viewer.browser.connections()).toBe(2);
  },
);

test("Native worker replacement recovers without leaving the assigned window", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await ready("https://other.example");
  act(() => {
    viewer.browser.resetWorker();
  });
  await pendingRecovery();
  viewer.advance(1000);
  await ready("https://other.example");
  await insertText("after worker loss");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("other"),
      params: { text: "after worker loss" },
    });
  });
  expect(
    screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
});

test("Rejected navigation remains local and does not trigger resource replay", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  viewer.browser.rejectNextNavigation("net::ERR_NAME_NOT_RESOLVED");
  await fill(screen.getByLabelText("Address"), "unreachable.example");
  await userEvent.keyboard("{Enter}");
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  viewer.advance(180_000);
  await insertText("healthy after rejected navigation");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)?.params).toMatchObject({
      text: "healthy after rejected navigation",
    });
  });
  expect(viewer.browser.connections()).toBe(1);
  expect(
    viewer.browser.requests.filter((request) => {
      return request.method === "Page.navigate";
    }),
  ).toHaveLength(1);
});

async function failImageAttempts(
  viewer: ReturnType<typeof mockViewer>,
  attempts: number,
) {
  for (const interval of [1000, 2000, 4000].slice(0, attempts)) {
    const image = viewer.browser.holdTargetFrames("example-page");
    viewer.advance(interval);
    await act(async () => {
      await image.received;
    });
    viewer.advance(31_000);
    await screen.findByText("Browser view unavailable");
    await act(() => {
      image.release();
    });
  }
}

test("Repeated missing retry images recover locally within the original budget", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const connections = viewer.browser.connections();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery("Retry live image");
  await failImageAttempts(viewer, 2);
  viewer.advance(4000);
  await ready();
  await insertText("after repeated missing images");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)?.params).toMatchObject({
      text: "after repeated missing images",
    });
  });
  expect(viewer.browser.connections()).toBe(connections);
});

test("Exhausted local image recovery permits a new manual image retry", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const connections = viewer.browser.connections();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery("Retry live image");
  await failImageAttempts(viewer, 3);
  const retry = await screen.findByText("Retry live image", {
    selector: "button",
  });
  await waitFor(() => {
    expect(retry).toBeEnabled();
  });
  click(retry);
  await ready();
  await insertText("after exhausted image recovery");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)?.params).toMatchObject({
      text: "after exhausted image recovery",
    });
  });
  expect(viewer.browser.connections()).toBe(connections);
});

test("Automatic recovery accepts an authoritative empty window without creating a tab", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.targets.splice(0, 2);
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  viewer.advance(1000);
  await screen.findByText("No tabs open");
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeEnabled();
  });
  expect(viewer.browser.targets).toHaveLength(1);
  expect(
    screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
});

test("Remote tab activation replaces the target restored by pending automatic recovery", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery("Retry live image");
  const image = viewer.browser.holdTargetFrames("other");
  act(() => {
    viewer.browser.event("BrowserUse.activeTargetChanged", {
      targetId: "other",
    });
  });
  await act(async () => {
    await image.received;
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
    image.release();
  });
  await pendingRecovery();
  viewer.advance(1000);
  await ready("https://other.example");
  await insertText("remote selection survives recovery");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      sessionId: viewer.browser.pageSession("other"),
      params: { text: "remote selection survives recovery" },
    });
  });
});

async function loseControlDuringImageRetry(
  viewer: ReturnType<typeof mockViewer>,
) {
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery("Retry live image");
  const image = viewer.browser.holdTargetFrames("example-page");
  viewer.advance(1000);
  await act(async () => {
    await image.received;
  });
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false }, 0);
    image.release();
  });
}

test.each(["shared", "split"] as const)(
  "Control loss during %s image retry continues the same recovery budget",
  async (transport) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    if (transport === "split") {
      await splitConnection();
    }
    await loseControlDuringImageRetry(viewer);
    await pendingRecovery();
    viewer.advance(2000);
    await ready();
    await insertText("after image and control loss");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)?.params).toMatchObject({
        text: "after image and control loss",
      });
    });
  },
);

test("Control loss after image retry leaves only two connection attempts before exhaustion", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  let reads = 0;
  let unavailable = true;
  const responses = Array.from({ length: 2 }, () => {
    return context.mocks.deferred<void>();
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    responses[reads++]?.resolve();
    return unavailable
      ? respond(503, {
          error: {
            code: "BROWSER_USE_SHARED_OPERATION_FAILED",
            message: "Temporarily unavailable",
          },
        })
      : respond(200, {
          browser: viewer.session(),
          cdpUrl: endpoint,
          extension: TEST_BROWSER_EXTENSION,
        });
  });
  await loseControlDuringImageRetry(viewer);
  await pendingRecovery();
  for (const [index, interval] of [2000, 4000].entries()) {
    viewer.advance(interval);
    await act(async () => {
      await responses[index]!.promise;
    });
  }
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  expect(reads).toBe(2);
  unavailable = false;
  viewer.advance(61_000);
  click(reconnect());
  await ready();
  expect(reads).toBe(3);
});
