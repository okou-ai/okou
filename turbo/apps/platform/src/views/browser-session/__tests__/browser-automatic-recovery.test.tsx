import {
  browserContract,
  type BrowserConnection,
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
import { initSentry } from "../../../lib/sentry.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const nextThreadId = "44444444-4444-4444-8444-444444444444";
const endpoint = "wss://browser.example/automatic?token=private";

function mockViewer(endpointAliases: readonly string[] = []) {
  let elapsed = 0;
  const now = Date.parse("2026-09-01T10:00:00Z");
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  mockNow(() => {
    return now + elapsed;
  }, context.signal);
  const errorLog = vi.spyOn(console, "error");
  const sentry = context.mocks.sentry();
  initSentry();
  const browser = mockBrowserCdp(context, endpoint, {
    endpointAliases,
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
  function session(id = threadId): BrowserConnection["browser"] {
    return {
      threadId: id,
      name: "automatic recovery",
      status: "active",
      viewerUrl: `https://viewer.example/browsers/${id}`,
      liveUrl: null,
      screenshotUrl: null,
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
    return respond(200, {
      browser: session(params.threadId),
      viewer: {
        browser: session(params.threadId),
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    return respond(200, { browser: session(params.threadId) });
  });
  return {
    browser,
    sentry,
    errorLogs() {
      return errorLog.mock.calls.filter(([prefix]) => {
        return prefix === "[E][Browser]" || prefix === "[E][Promise]";
      });
    },
    session,
    start(refined = false) {
      return setupPage({
        context,
        path: `/browsers/${threadId}`,
        featureSwitches: {
          [FeatureSwitchKey.CloudBrowserPanel]: refined,
        },
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

async function pendingRecovery() {
  const status = await screen.findByText("Reconnecting…");
  expect(status).toHaveAttribute("role", "status");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  return status;
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

async function replaceRecoveringEndpoint(attempts: 1 | 3, interval: number) {
  const nextEndpoint = "wss://browser.example/replaced?token=private";
  const viewer = mockViewer([nextEndpoint]);
  const received = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let reads = 0;
  context.mocks.api(browserContract.get, async ({ respond }) => {
    reads++;
    if (reads === 2) {
      received.resolve();
      await release.promise;
    }
    return respond(200, {
      browser: viewer.session(),
      viewer: {
        browser: viewer.session(),
        cdpUrl: reads === 1 ? endpoint : nextEndpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  await failImageAttempts(viewer, attempts - 1);
  const image = viewer.browser.holdTargetFrames("example-page");
  viewer.advance(interval);
  await image.received;
  const replacement = viewer.browser;
  const initialization = replacement.holdNext("Page.enable");
  const nextImage = replacement.holdTargetFrames("example-page");
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await received.promise;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(() => {
    release.resolve();
  });
  await initialization.received;
  await pendingRecovery();
  return {
    viewer,
    replacement,
    nextEndpoint,
    initialization,
    nextImage,
    image,
    connectionReads: () => {
      return reads;
    },
  };
}

async function revalidatePaintedRecovery(
  attempts: 1 | 3,
  interval: number,
  outcome: "ready" | "terminal" | "absent" = "ready",
) {
  const viewer = mockViewer();
  const received = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const notified = context.mocks.deferred<void>();
  let reads = 0;
  context.mocks.api(browserContract.get, async ({ respond }) => {
    reads++;
    if (reads === 2) {
      received.resolve();
      await release.promise;
      if (outcome === "terminal") {
        return respond(409, {
          error: { code: "CONFLICT", message: "The assigned window was lost" },
        });
      }
      if (outcome === "absent") {
        return respond(200, {
          browser: {
            ...viewer.session(),
            status: "suspended",
            window: undefined,
          },
          viewer: null,
        });
      }
    }
    return respond(200, {
      browser: viewer.session(),
      viewer: {
        browser: viewer.session(),
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  await failImageAttempts(viewer, attempts - 1);
  const image = viewer.browser.holdTargetFrames("example-page");
  viewer.advance(interval);
  await image.received;
  const canvas = screen.getByLabelText<HTMLCanvasElement>("Live browser view");
  const rendering = canvas.getContext("2d")!;
  const drawImage = rendering.drawImage.bind(rendering);
  const notify = (jobs: number): void => {
    if (context.signal.aborted) {
      return;
    }
    if (jobs > 0) {
      queueMicrotask(() => {
        notify(jobs - 1);
      });
      return;
    }
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
    notified.resolve();
  };
  vi.spyOn(rendering, "drawImage").mockImplementationOnce((picture, x, y) => {
    drawImage(picture, x, y);
    // Deliberately interleave the external notification with the successful
    // native attempt's Promise jobs. This is not provider scheduling evidence.
    notify(12);
  });
  await act(image.release);
  await notified.promise;
  await received.promise;
  return {
    viewer,
    release: () => {
      release.resolve();
    },
    reads: () => {
      return reads;
    },
  };
}

test.each([1, 3] as const)(
  "A successful image attempt %i stays pending through same-binding revalidation",
  async (attempts) => {
    const { viewer, release, reads } = await revalidatePaintedRecovery(
      attempts,
      attempts === 1 ? 1000 : 4000,
    );
    await pendingRecovery();
    expect(viewer.sentry.reports).toHaveLength(0);
    await act(release);
    await ready();
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    await insertText("input after successful attempt revalidation");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        sessionId: viewer.browser.pageSession("example-page"),
        params: { text: "input after successful attempt revalidation" },
      });
    });
    act(() => {
      viewer.browser.frame("!");
    });
    await pendingRecovery();
    viewer.advance(1000);
    await ready();
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    expect(reads()).toBe(2);
    expect(viewer.browser.connections()).toBe(1);
    expect(viewer.sentry.reports).toHaveLength(0);
    expect(viewer.errorLogs()).toHaveLength(0);
  },
);

test("A successful image attempt retains the original deadline during revalidation", async () => {
  const { viewer, release, reads } = await revalidatePaintedRecovery(
    3,
    114_000,
  );
  viewer.advance(999);
  await pendingRecovery();
  expect(viewer.sentry.reports).toHaveLength(0);
  viewer.advance(1);
  await waitFor(() => {
    expect(viewer.sentry.reports).toHaveLength(1);
  });
  expect(viewer.sentry.reports[0]).toMatchObject({
    error: { kind: "frame" },
    context: { contexts: { browser_recovery: { outcome: "exhausted" } } },
  });
  expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(release);
  await ready();
  await insertText("input after expired successful attempt");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      sessionId: viewer.browser.pageSession("example-page"),
      params: { text: "input after expired successful attempt" },
    });
  });
  expect(reads()).toBe(2);
  expect(viewer.browser.connections()).toBe(1);
  expect(viewer.sentry.reports).toHaveLength(1);
});

test("A successful image attempt preserves a current terminal descriptor error", async () => {
  const { viewer, release } = await revalidatePaintedRecovery(
    1,
    1000,
    "terminal",
  );
  await pendingRecovery();
  await act(release);
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  // The rejected descriptor read also reaches the shared Promise reporting
  // boundary. Preserve it and the coordinator's one final report in order.
  expect(viewer.sentry.reports).toHaveLength(2);
  expect(viewer.sentry.reports).toMatchObject([
    {
      error: { name: "ApiError", status: 409, code: "CONFLICT" },
      context: { tags: { logger: "Promise" } },
    },
    {
      error: { kind: "protocol" },
      context: {
        tags: { browser_event: "recovery-stopped", logger: "Browser" },
        contexts: {
          browser_recovery: { outcome: "terminal" },
          browser_http: { status: 409, code: "CONFLICT" },
        },
      },
    },
  ]);
  click(reconnect());
  await ready();
  expect(viewer.sentry.reports).toHaveLength(2);
  expect(viewer.errorLogs()).toHaveLength(1);
});

test("Confirmed suspension after a successful image attempt leaves no pending viewer", async () => {
  const { release } = await revalidatePaintedRecovery(1, 1000, "absent");
  await pendingRecovery();
  await act(release);
  await screen.findByText("Start browser", { selector: "button" });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  });
});

test.each([1, 3] as const)(
  "A same-window endpoint replacement preserves recovery attempt %i",
  async (attempts) => {
    const {
      viewer,
      replacement,
      nextEndpoint,
      initialization,
      nextImage,
      image,
      connectionReads,
    } = await replaceRecoveringEndpoint(attempts, attempts === 1 ? 1000 : 4000);
    await act(initialization.release);
    await nextImage.received;
    expect(connectionReads()).toBe(2);
    expect(replacement.connections(nextEndpoint)).toBe(1);
    await pendingRecovery();
    await act(() => {
      nextImage.release(attempts === 3 ? "AAAA" : "!");
    });
    if (attempts === 1) {
      await pendingRecovery();
      viewer.advance(2000);
    }
    await ready();
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    act(image.release);
    await insertText("input after endpoint replacement");
    await waitFor(() => {
      expect(replacement.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        sessionId: replacement.pageSession("example-page"),
        params: { text: "input after endpoint replacement" },
      });
    });
    expect(viewer.browser.connections(endpoint)).toBe(1);
    expect(viewer.sentry.reports).toHaveLength(0);
  },
);

test("A same-window endpoint replacement keeps the original recovery deadline", async () => {
  // The first two failed image attempts consume 65 seconds. Start the last at
  // 179 seconds, leaving only the original episode's last second for new work.
  const {
    viewer,
    replacement,
    nextEndpoint,
    initialization,
    nextImage,
    image,
    connectionReads,
  } = await replaceRecoveringEndpoint(3, 114_000);
  viewer.advance(999);
  await pendingRecovery();
  expect(viewer.sentry.reports).toHaveLength(0);
  viewer.advance(1);
  await waitFor(() => {
    expect(viewer.sentry.reports).toHaveLength(1);
  });
  expect(viewer.sentry.reports[0]).toMatchObject({
    context: { contexts: { browser_recovery: { outcome: "exhausted" } } },
  });
  await act(initialization.release);
  await nextImage.received;
  expect(connectionReads()).toBe(2);
  expect(replacement.connections(nextEndpoint)).toBe(1);
  await act(() => {
    nextImage.release("!");
  });
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  viewer.advance(4000);
  expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(connectionReads()).toBe(2);
  expect(replacement.connections(nextEndpoint)).toBe(1);
  click(reconnect());
  await ready();
  await waitFor(() => {
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  });
  act(image.release);
  await insertText("manual input after expired handoff");
  await waitFor(() => {
    expect(replacement.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: replacement.pageSession("example-page"),
      params: { text: "manual input after expired handoff" },
    });
  });
  expect(viewer.browser.connections(endpoint)).toBe(1);
  expect(viewer.sentry.reports).toHaveLength(1);
});

test.each(["removed", "moved"] as const)(
  "A %s selected tab hands off to a scoped successor without a final recovery error",
  async (loss) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    const initialization = viewer.browser.holdNext("Page.enable");
    const picture = viewer.browser.holdTargetFrames("other");
    act(() => {
      if (loss === "removed") {
        viewer.browser.event("Target.targetDestroyed", {
          targetId: "example-page",
        });
      } else {
        viewer.browser.move("example-page", 202);
      }
    });
    await act(async () => {
      await initialization.received;
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(viewer.sentry.reports).toHaveLength(0);
    await act(initialization.release);
    await act(async () => {
      await picture.received;
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(viewer.sentry.reports).toHaveLength(0);
    act(() => {
      picture.release();
    });
    await ready("https://other.example");
    await insertText("successor input");
    await waitFor(() => {
      expect(viewer.browser.input).toContainEqual({
        method: "Input.insertText",
        sessionId: viewer.browser.pageSession("other"),
        params: { text: "successor input" },
      });
    });
    expect(viewer.sentry.reports).toHaveLength(0);
    expect(viewer.errorLogs()).toHaveLength(0);
  },
);

test.each(["healthy", "recovering"] as const)(
  "Selected-target loss from a %s viewer waits for complete empty inventory before offering a new tab",
  async (phase) => {
    const viewer = mockViewer();
    viewer.browser.targets.push(
      {
        targetId: "known-sibling",
        title: "Known sibling",
        url: "https://known-sibling.example",
        windowId: 202,
      },
      {
        targetId: "pending-sibling",
        title: "Pending sibling",
        url: "https://pending-sibling.example",
        windowId: 202,
      },
    );
    const inventory = viewer.browser.holdNextMembership("pending-sibling");
    await viewer.start();
    await inventory.received;
    await ready();
    if (phase === "recovering") {
      act(() => {
        viewer.browser.frame("!");
      });
      await pendingRecovery();
    }
    act(() => {
      viewer.browser.event("Target.targetDestroyed", { targetId: "other" });
      viewer.browser.event("Target.targetDestroyed", {
        targetId: "example-page",
      });
    });
    await screen.findByText("Connecting to browser…");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
    expect(screen.queryByText("No tabs open")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    viewer.advance(1000);
    expect(viewer.sentry.reports).toHaveLength(0);
    await act(inventory.release);
    await screen.findByText("No tabs open");
    const create = screen.getByLabelText("New tab", { selector: "button" });
    expect(create).toBeEnabled();
    expect(viewer.sentry.reports).toHaveLength(0);
    click(create);
    await ready("");
    expect(viewer.browser.targets).toContainEqual(
      expect.objectContaining({ windowId: 101, url: "about:blank" }),
    );
    expect(viewer.sentry.reports).toHaveLength(0);
  },
);

test.each([false, true])(
  "Closing a target after exhausted image recovery preserves its original report (pending inventory: %s)",
  async (pendingInventory) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    act(() => {
      viewer.browser.frame("!");
    });
    await pendingRecovery();
    await exhaustImageRecovery(viewer);
    const reports = [...viewer.sentry.reports];
    expect(reports).toHaveLength(1);
    expect(reports).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ kind: "frame" }),
        context: expect.objectContaining({
          contexts: expect.objectContaining({
            browser_recovery: { outcome: "exhausted" },
          }),
        }),
      }),
    );
    const membership = pendingInventory
      ? viewer.browser.holdNextMembership("new-sibling")
      : null;
    if (membership) {
      act(() => {
        const target = {
          targetId: "new-sibling",
          title: "New sibling",
          url: "https://new-sibling.example",
          windowId: 202,
        };
        viewer.browser.targets.push(target);
        viewer.browser.event("Target.targetCreated", {
          targetInfo: { ...target, type: "page" },
        });
      });
      await membership.received;
    }
    act(() => {
      viewer.browser.event("Target.targetDestroyed", { targetId: "other" });
      viewer.browser.event("Target.targetDestroyed", {
        targetId: "example-page",
      });
    });
    await screen.findByText(
      pendingInventory ? "Connecting to browser…" : "No tabs open",
    );
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    expect(viewer.sentry.reports).toStrictEqual(reports);
    viewer.advance(1000);
    if (membership) {
      await act(membership.release);
    }
    await screen.findByText("No tabs open");
    expect(viewer.sentry.reports).toStrictEqual(reports);
    click(screen.getByLabelText("New tab", { selector: "button" }));
    await ready("");
    expect(viewer.sentry.reports).toStrictEqual(reports);
  },
);

test.each(["recovering", "exhausted"] as const)(
  "Manual selection from %s image recovery does not revive the retired failure",
  async (phase) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    act(() => {
      viewer.browser.frame("!");
    });
    await pendingRecovery();
    if (phase === "exhausted") {
      await exhaustImageRecovery(viewer);
    }
    const original = [...viewer.sentry.reports];
    expect(original).toHaveLength(phase === "exhausted" ? 1 : 0);
    const initialization = viewer.browser.holdNext("Page.enable");
    const picture = viewer.browser.holdTargetFrames("other");
    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await act(async () => {
      await initialization.received;
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(viewer.sentry.reports).toStrictEqual(original);
    viewer.advance(1000);
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    expect(viewer.sentry.reports).toStrictEqual(original);
    await act(initialization.release);
    await act(async () => {
      await picture.received;
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(viewer.sentry.reports).toStrictEqual(original);
    act(picture.release);
    await ready("https://other.example");
    await insertText("manual successor input");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        sessionId: viewer.browser.pageSession("other"),
        params: { text: "manual successor input" },
      });
    });
    expect(viewer.sentry.reports).toStrictEqual(original);
  },
);

test("A new successor failure is reported after superseding an exhausted image failure", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  await exhaustImageRecovery(viewer);
  const original = [...viewer.sentry.reports];
  expect(original).toHaveLength(1);
  viewer.browser.failNext("Page.enable", "Unavailable method", -32_601);
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  expect(viewer.sentry.reports).toHaveLength(3);
  expect(viewer.sentry.reports[0]).toStrictEqual(original[0]);
  expect(viewer.sentry.reports.slice(original.length)).toMatchObject([
    {
      error: {
        kind: "unsupported-capability",
        request: { method: "Page.enable", code: -32_601 },
      },
      context: { contexts: { browser_recovery: { outcome: "terminal" } } },
    },
    {
      error: {
        kind: "protocol",
        request: { method: "Page.enable", code: -32_601 },
      },
      context: { tags: { logger: "Promise" } },
    },
  ]);
  click(reconnect());
  await ready("https://other.example");
  expect(viewer.sentry.reports).toHaveLength(3);
});

test("Recovery waits for a pending descriptor and selection without reporting its remembered failure", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const received = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let reads = 0;
  context.mocks.api(browserContract.get, async ({ respond }) => {
    reads++;
    received.resolve();
    await release.promise;
    return respond(200, {
      browser: viewer.session(),
      viewer: {
        browser: viewer.session(),
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await received.promise;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  const initialization = viewer.browser.holdNext("Page.enable");
  viewer.advance(1000);
  await act(() => {
    release.resolve();
  });
  await act(async () => {
    await initialization.received;
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  viewer.advance(2000);
  await act(initialization.release);
  await ready();
  await waitFor(() => {
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  });
  expect(reads).toBe(1);
  expect(viewer.browser.connections()).toBe(1);
  expect(viewer.sentry.reports).toHaveLength(0);
});

test("Retained input readmission completes recovery after toolbar interaction", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await ready();
  expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  const selected = viewer.browser.holdNextMembership("example-page");
  act(() => {
    const target = {
      targetId: "readmission-background",
      title: "Readmission background",
      url: "https://readmission.example",
      windowId: 101,
    };
    viewer.browser.targets.push(target);
    viewer.browser.nativeEvent("tab-created", target);
    viewer.browser.event("Target.targetCreated", {
      targetInfo: { ...target, type: "page" },
    });
    viewer.advance(1000);
  });
  await selected.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toBeEnabled();
  });
  const draft = "https://retained-draft.example/path";
  await fill(screen.getByLabelText("Address"), draft);
  expect(screen.getByLabelText("Address")).toHaveValue(draft);
  click(screen.getByLabelText("Browser settings"));
  await screen.findByRole("menu", { name: "Browser settings" });
  await userEvent.keyboard("{Escape}");
  expect(
    screen.queryByRole("menu", { name: "Browser settings" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  await act(selected.release);
  await ready(draft);
  await waitFor(() => {
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  });
  viewer.advance(180_000);
  await insertText("input after retained readmission");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("example-page"),
      params: { text: "input after retained readmission" },
    });
  });
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  viewer.advance(1000);
  await ready(draft);
  await waitFor(() => {
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  });
  expect(viewer.browser.connections()).toBe(1);
  expect(viewer.sentry.reports).toHaveLength(0);
});

async function createDuringImageRecovery(
  viewer: ReturnType<typeof mockViewer>,
) {
  const creation = viewer.browser.holdNextNative("createTab");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await creation.received;
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  const image = viewer.browser.holdTargetFrames("example-page");
  viewer.advance(1000);
  await act(async () => {
    await image.received;
  });
  return { creation, image };
}

test.each(["removed", "moved"] as const)(
  "A %s image-recovery target preserves an independent pending creation",
  async (loss) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    const { creation, image } = await createDuringImageRecovery(viewer);
    act(() => {
      if (loss === "removed") {
        viewer.browser.event("Target.targetDestroyed", {
          targetId: "example-page",
        });
      } else {
        viewer.browser.move("example-page", 202);
      }
    });
    await act(creation.release);
    act(image.release);
    await ready("");
    expect(viewer.browser.targets).toContainEqual(
      expect.objectContaining({
        targetId: "created-1",
        windowId: 101,
        url: "about:blank",
      }),
    );
    await insertText("independent creation survives");
    await waitFor(() => {
      expect(viewer.browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        sessionId: viewer.browser.pageSession("created-1"),
        params: { text: "independent creation survives" },
      });
    });
    expect(viewer.sentry.reports).toHaveLength(0);
  },
);

test("An explicit selection supersedes pending creation during image recovery", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const { creation, image } = await createDuringImageRecovery(viewer);
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await ready("https://other.example");
  await act(creation.release);
  act(image.release);
  await waitFor(() => {
    expect(viewer.browser.targets).toHaveLength(3);
  });
  await insertText("explicit choice survives");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      sessionId: viewer.browser.pageSession("other"),
      params: { text: "explicit choice survives" },
    });
  });
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await ready("");
  expect(viewer.browser.targets).toContainEqual(
    expect.objectContaining({
      targetId: "created-2",
      windowId: 101,
      url: "about:blank",
    }),
  );
  expect(viewer.sentry.reports).toHaveLength(0);
});

test("Manual retry of a retired failure permits a later independent automatic recovery", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  await exhaustImageRecovery(viewer);
  const original = [...viewer.sentry.reports];
  expect(original).toHaveLength(1);
  click(screen.getByLabelText("Close Other"));
  await waitFor(() => {
    expect(
      screen.queryByLabelText("Other", { selector: '[role="tab"]' }),
    ).not.toBeInTheDocument();
  });
  click(screen.getByText("Retry live image", { selector: "button" }));
  await ready();
  expect(viewer.sentry.reports).toStrictEqual(original);
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  viewer.advance(1000);
  await ready();
  expect(viewer.sentry.reports).toStrictEqual(original);
});

test("A failed successor reports its own terminal initialization error after target loss", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  viewer.browser.failNext("Page.enable", "Unavailable method", -32_601);
  act(() => {
    viewer.browser.move("example-page", 202);
  });
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  const finalFailures = viewer.sentry.reports.filter((report) => {
    const details = report.context;
    return (
      typeof details === "object" &&
      details !== null &&
      "tags" in details &&
      details.tags?.browser_event === "recovery-stopped"
    );
  });
  expect(finalFailures).toHaveLength(1);
  expect(finalFailures[0]).toMatchObject({
    error: {
      name: "CdpFault",
      kind: "unsupported-capability",
      request: { method: "Page.enable", code: -32_601 },
    },
    context: { contexts: { browser_recovery: { outcome: "terminal" } } },
  });
  for (const report of viewer.sentry.reports) {
    expect(report).toMatchObject({
      error: { request: { method: "Page.enable", code: -32_601 } },
    });
  }
  const reportCount = viewer.sentry.reports.length;
  click(reconnect());
  await ready("https://other.example");
  expect(viewer.sentry.reports).toHaveLength(reportCount);
});

test("The refined panel shows a non-blocking recovery status without a reclaim footer", async () => {
  const viewer = mockViewer();
  await viewer.start(true);
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  expect(screen.queryByText(/Kept while open/)).not.toBeInTheDocument();
  expect(
    screen.queryByText("Browser view unavailable"),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "Live browser view" }),
  ).toBeInTheDocument();
  viewer.advance(1000);
  await ready();
  expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
});

test.each([false, true])(
  "Local address editing survives recovery (binding replaced=%s)",
  async (replace) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    const address = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Address",
    });
    await fill(address, "kept.example/path");
    await userEvent.keyboard("{Home}{ArrowRight}");
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await pendingRecovery();
    expect(address).toBeEnabled();
    expect(address).toHaveFocus();
    await userEvent.keyboard("x{Enter}");
    expect(address).toHaveValue("kxept.example/path");
    if (replace) {
      viewer.replaceBinding();
    }
    viewer.advance(1000);
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(address).toHaveFocus();
    expect(address.selectionStart).toBe(2);
    expect(address).toHaveValue("kxept.example/path");
    expect(viewer.browser.targets[0]?.url).toBe("https://original.example");
    expect(viewer.browser.targets[2]?.url).toBe("https://sibling.example");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue(
        replace ? "kxept.example/path" : "http://kxept.example/path",
      );
    });
    expect(viewer.browser.targets[0]?.url).toBe(
      replace ? "https://original.example" : "http://kxept.example/path",
    );
    expect(viewer.browser.targets[2]?.url).toBe("https://sibling.example");
    await userEvent.keyboard("{Escape}");
    expect(address).toHaveValue(
      replace ? "https://sibling.example" : "http://kxept.example/path",
    );
  },
);

test("A clean address selection survives binding replacement and releases on blur", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const address = screen.getByLabelText<HTMLInputElement>("Address");
  await userEvent.click(address);
  await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  viewer.replaceBinding();
  viewer.advance(1000);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(address).toHaveFocus();
  expect(address).toHaveValue("https://original.example");
  expect(address.selectionStart).toBe(2);
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  expect(address).toHaveValue("https://sibling.example");
  await fill(address, "chosen.example/path");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://chosen.example/path");
  });
  expect(viewer.browser.targets[0]?.url).toBe("https://original.example");
  expect(viewer.browser.targets[2]?.url).toBe("http://chosen.example/path");
});

test("A submitted address can start a fresh selection after connection recovery", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const navigation = viewer.browser.holdNext("Page.navigate");
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Address",
  });
  await fill(address, "submitted.example/path");
  await userEvent.keyboard("{Enter}");
  await navigation.received;
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  viewer.advance(1000);
  await ready("http://submitted.example/path");
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  await userEvent.click(address);
  await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
  const proof = viewer.browser.holdNextMembership("example-page");
  act(() => {
    viewer.browser.duplicate("example-page");
  });
  await proof.received;
  expect(address).toHaveValue("http://submitted.example/path");
  expect(address).toHaveFocus();
  expect(address.selectionStart).toBe(2);
  await act(async () => {
    await proof.release();
  });
  await ready("http://submitted.example/path");
  expect(address).toHaveFocus();
  expect(address.selectionStart).toBe(2);
});

test.each([false, true])(
  "Interacting with a recovered submission cannot transfer it to an automatic successor (type=%s)",
  async (type) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    const navigation = viewer.browser.holdNext("Page.navigate");
    const address = screen.getByLabelText("Address");
    await fill(address, "submitted.example/path");
    await userEvent.keyboard("{Enter}");
    await navigation.received;
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await pendingRecovery();
    act(() => {
      viewer.browser.move("example-page", 202);
    });
    viewer.advance(1000);
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
      expect(
        screen.getByLabelText("Other", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    await userEvent.click(screen.getByLabelText("Remote browser input"));
    await userEvent.click(address);
    if (type) {
      await userEvent.keyboard("{Home}x");
    }
    await userEvent.keyboard("{Enter}");
    expect(address).toHaveValue(
      type ? "xsubmitted.example/path" : "submitted.example/path",
    );
    expect(viewer.browser.targets[1]?.url).toBe("https://other.example");
  },
);

test("An address first edited during recovery stays bound to the restored tab", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  const membership = viewer.browser.holdNextMembership("example-page");
  viewer.advance(1000);
  await membership.received;
  const address = screen.getByLabelText("Address");
  await fill(address, "during-recovery.example/path");
  await userEvent.keyboard("{Enter}");
  await act(async () => {
    await membership.release();
  });
  await ready("during-recovery.example/path");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://during-recovery.example/path");
  });
  expect(viewer.browser.targets[0]?.url).toBe(
    "http://during-recovery.example/path",
  );
});

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
  context.mocks.api(browserContract.get, ({ respond }) => {
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
          viewer: {
            browser: viewer.session(),
            cdpUrl: endpoint,
            extension: TEST_BROWSER_EXTENSION,
          },
        });
  });
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  for (const [index, interval] of [1000, 2000, 4000].entries()) {
    expect(viewer.sentry.reports).toHaveLength(0);
    expect(viewer.errorLogs()).toHaveLength(0);
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
  expect(viewer.sentry.reports).toHaveLength(0);
  expect(viewer.errorLogs()).toHaveLength(0);
  expect(
    screen.queryByLabelText("Sibling", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
});

test.each(["shared", "split"] as const)(
  "%s recovery keeps the presented picture through failed attempts and replaces it only with a fresh frame",
  async (transport) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    if (transport === "split") {
      await splitConnection();
    }
    const canvas =
      screen.getByLabelText<HTMLCanvasElement>("Live browser view");
    const renderer = canvas.getContext("2d")!;
    const clear = vi.spyOn(renderer, "clearRect");
    const paint = vi.spyOn(renderer, "drawImage");
    const dimensions = [canvas.width, canvas.height];
    const visibleFailures: string[] = [];
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          const text = node.textContent ?? "";
          if (
            text.includes("Browser disconnected") ||
            text.includes("Browser view unavailable")
          ) {
            visibleFailures.push(text);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    context.signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
    let reads = 0;
    const replies = Array.from({ length: 3 }, () => {
      return context.mocks.deferred<void>();
    });
    const fresh = viewer.browser.holdTargetFrames("example-page");
    context.mocks.api(browserContract.get, ({ respond }) => {
      replies[reads++]!.resolve();
      return reads < 3
        ? respond(500, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Temporary descriptor failure",
            },
          })
        : respond(200, {
            browser: viewer.session(),
            viewer: {
              browser: viewer.session(),
              cdpUrl: endpoint,
              extension: TEST_BROWSER_EXTENSION,
            },
          });
    });
    act(() => {
      return viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    const status = await pendingRecovery();
    expect(status.parentElement).toHaveTextContent(
      "Kept while open; reclaimed after 10 idle minutes.",
    );
    for (const [index, interval] of [1000, 2000, 4000].entries()) {
      viewer.advance(interval);
      await act(async () => {
        await replies[index]!.promise;
      });
      expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
      expect(
        screen.queryByText("Browser view unavailable"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(clear).not.toHaveBeenCalled();
      expect(paint).not.toHaveBeenCalled();
      expect([canvas.width, canvas.height]).toStrictEqual(dimensions);
    }
    await fresh.received;
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(canvas).toHaveAttribute("aria-hidden", "false");
    act(() => {
      return fresh.release();
    });
    await ready();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    expect(visibleFailures).toStrictEqual([]);
  },
);

test.each(["shared", "split"] as const)(
  "%s connection recovery preserves pixels and rejects a late decode from its retired frame generation",
  async (transport) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    if (transport === "split") {
      await splitConnection();
    }
    const canvas =
      screen.getByLabelText<HTMLCanvasElement>("Live browser view");
    const renderer = canvas.getContext("2d")!;
    const clear = vi.spyOn(renderer, "clearRect");
    const paint = vi.spyOn(renderer, "drawImage");
    const decode = context.mocks.deferred<ImageBitmap>();
    const started = context.mocks.deferred<void>();
    vi.spyOn(globalThis, "createImageBitmap").mockImplementationOnce(() => {
      started.resolve();
      return decode.promise;
    });
    act(() => {
      return viewer.browser.frame("YQ==");
    });
    await started.promise;
    act(() => {
      return viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await pendingRecovery();
    viewer.advance(1000);
    await ready();
    expect(clear).not.toHaveBeenCalled();
    const draws = paint.mock.calls.length;
    const close = vi.fn<() => void>();
    await act(async () => {
      decode.resolve({ width: 1440, height: 900, close } as ImageBitmap);
      await decode.promise;
    });
    await waitFor(() => {
      return expect(close).toHaveBeenCalledOnce();
    });
    expect(paint).toHaveBeenCalledTimes(draws);
    expect(clear).not.toHaveBeenCalled();
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  },
);

test("A different selected target clears the previous picture while its first frame is pending", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const canvas = screen.getByLabelText<HTMLCanvasElement>("Live browser view");
  const clear = vi.spyOn(canvas.getContext("2d")!, "clearRect");
  const fresh = viewer.browser.holdTargetFrames("other");
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await fresh.received;
  expect(clear).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
  expect(canvas).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    return fresh.release();
  });
  await ready("https://other.example");
});

test.each(["attempt", "pacing"] as const)(
  "Definitive authorization loss during %s clears the picture and ends the reconnecting notice",
  async (phase) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    const canvas =
      screen.getByLabelText<HTMLCanvasElement>("Live browser view");
    const clear = vi.spyOn(canvas.getContext("2d")!, "clearRect");
    const denied = context.mocks.deferred<void>();
    context.mocks.api(browserContract.get, ({ respond }) => {
      denied.resolve();
      return respond(403, { error: { code: "FORBIDDEN", message: "Revoked" } });
    });
    act(() => {
      return viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await pendingRecovery();
    if (phase === "pacing") {
      act(() => {
        context.mocks.ably.trigger("browserSessionChanged", { threadId });
      });
      await act(async () => {
        await denied.promise;
      });
    }
    await waitFor(() => {
      expect(canvas).toHaveAttribute(
        "aria-hidden",
        phase === "pacing" ? "true" : "false",
      );
    });
    expect(viewer.sentry.reports).toHaveLength(0);
    viewer.advance(1000);
    await waitFor(() => {
      return expect(reconnect()).toBeEnabled();
    });
    expect(clear).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(viewer.sentry.reports).toHaveLength(1);
    expect(viewer.sentry.reports[0]).toMatchObject({
      context: {
        tags: { browser_event: "recovery-stopped", logger: "Browser" },
        contexts: {
          browser_recovery: { outcome: "terminal" },
          browser_http: { status: 403, code: "FORBIDDEN" },
        },
      },
    });
  },
);

test.each(["shared", "split"] as const)(
  "Automatic %s image recovery retains healthy control",
  async (transport) => {
    const viewer = mockViewer();
    await viewer.start();
    await ready();
    if (transport === "split") {
      await splitConnection();
    }
    const canvas =
      screen.getByLabelText<HTMLCanvasElement>("Live browser view");
    const clear = vi.spyOn(canvas.getContext("2d")!, "clearRect");
    const connections = viewer.browser.connections();
    act(() => {
      viewer.browser.frame("!");
    });
    await pendingRecovery();
    expect(clear).not.toHaveBeenCalled();
    expect(canvas).toHaveAttribute("aria-hidden", "false");
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
    expect(clear).not.toHaveBeenCalled();
    expect(viewer.sentry.reports).toHaveLength(0);
    expect(viewer.errorLogs()).toHaveLength(0);
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
  context.mocks.api(browserContract.get, ({ respond }) => {
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
          viewer: {
            browser: viewer.session(),
            cdpUrl: endpoint,
            extension: TEST_BROWSER_EXTENSION,
          },
        });
  });
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  for (const [index, interval] of [1000, 2000, 4000].entries()) {
    expect(viewer.sentry.reports).toHaveLength(0);
    expect(viewer.errorLogs()).toHaveLength(0);
    viewer.advance(interval);
    await act(async () => {
      await replies[index]!.promise;
    });
  }
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(viewer.sentry.reports).toHaveLength(1);
  expect(viewer.sentry.reports[0]).toMatchObject({
    context: {
      tags: { browser_event: "recovery-stopped", logger: "Browser" },
      contexts: {
        browser_recovery: { outcome: "exhausted" },
        browser_http: { status: 500, code: "INTERNAL_SERVER_ERROR" },
      },
    },
  });
  expect(viewer.errorLogs()).toHaveLength(0);
  unavailable = false;
  viewer.advance(61_000);
  click(reconnect());
  await ready();
  expect(reads).toBe(4);
  expect(viewer.sentry.reports).toHaveLength(1);
});

test.each([403, 409] as const)(
  "HTTP %s is terminal until an explicit recovery action",
  async (status) => {
    const viewer = mockViewer();
    let denied = true;
    let reads = 0;
    context.mocks.api(browserContract.get, ({ respond }) => {
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
            viewer: {
              browser: viewer.session(),
              cdpUrl: endpoint,
              extension: TEST_BROWSER_EXTENSION,
            },
          });
    });
    await viewer.start();
    await screen.findByText("Browser view unavailable");
    await waitFor(() => {
      expect(reconnect()).toBeEnabled();
    });
    expect(viewer.sentry.reports).toHaveLength(1);
    click(reconnect());
    await waitFor(() => {
      expect(viewer.sentry.reports).toHaveLength(2);
      expect(reconnect()).toBeEnabled();
    });
    expect(viewer.errorLogs()).toHaveLength(0);
    viewer.advance(180_000);
    denied = false;
    click(reconnect());
    await ready();
    expect(reads).toBe(3);
    expect(viewer.sentry.reports).toHaveLength(2);
  },
);

test("The episode ceiling ends a stalled descriptor and late work cannot start another budget", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const navigation = viewer.browser.holdNext("Page.navigate");
  await fill(screen.getByLabelText("Address"), "next.example");
  await userEvent.keyboard("{Enter}");
  await navigation.received;
  const received = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let reads = 0;
  context.mocks.api(browserContract.get, async ({ respond }) => {
    reads++;
    if (reads === 1) {
      received.resolve();
      await release.promise;
    }
    return respond(200, {
      browser: viewer.session(),
      viewer: {
        browser: viewer.session(),
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  act(() => {
    viewer.browser.failConnection();
  });
  await pendingRecovery();
  viewer.advance(1000);
  await act(async () => {
    await received.promise;
  });
  expect(viewer.sentry.reports).toHaveLength(0);
  expect(viewer.errorLogs()).toHaveLength(0);
  viewer.advance(180_000);
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  expect(viewer.sentry.reports).toHaveLength(1);
  expect(viewer.sentry.reports[0]).toMatchObject({
    type: "exception",
    error: { name: "CdpFault", kind: "connection" },
    context: {
      contexts: {
        browser_recovery: { outcome: "exhausted" },
        browser_connection: {
          source: "native-error",
          role: "control",
          phase: "open",
          ready_state: 3,
          pending_requests: 1,
        },
      },
    },
  });
  expect(JSON.stringify(viewer.sentry.reports)).not.toContain("private");
  await act(() => {
    release.resolve();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(reconnect());
  await ready("http://next.example/");
  await act(async () => {
    await navigation.release();
  });
  expect(reads).toBe(2);
  expect(viewer.sentry.reports).toHaveLength(1);
  expect(viewer.errorLogs()).toHaveLength(0);
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

test("The episode ceiling shows its final error while the last native bootstrap is still pending", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  for (const interval of [1000, 2000]) {
    const attachment = viewer.browser.holdNext("Target.attachToTarget");
    viewer.advance(interval);
    await attachment.received;
    viewer.advance(61_000);
    await waitFor(() => {
      expect(viewer.browser.activeConnections()).toBe(0);
    });
    await act(async () => {
      await attachment.release();
    });
  }
  const attachment = viewer.browser.holdNext("Target.attachToTarget");
  viewer.advance(4000);
  await attachment.received;
  viewer.advance(51_000);
  await waitFor(() => {
    expect(reconnect()).toBeEnabled();
  });
  expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  expect(screen.queryByText("Connecting to browser…")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The browser did not become ready in time. Reconnect the browser.",
  );
  expect(viewer.sentry.reports).toHaveLength(1);
  click(reconnect());
  await ready();
  await act(async () => {
    await attachment.release();
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(viewer.sentry.reports).toHaveLength(1);
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
  await pendingRecovery();
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
  expect(viewer.sentry.reports).toHaveLength(0);
  expect(viewer.errorLogs()).toHaveLength(0);
});

test("The final split image failure retains its original connection observations", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  await splitConnection();
  act(() => {
    viewer.browser.disconnect({ code: 1006, wasClean: false }, 1);
  });
  await pendingRecovery();
  viewer.advance(180_000);
  const retry = await screen.findByText("Retry live image", {
    selector: "button",
  });
  await waitFor(() => {
    expect(retry).toBeEnabled();
  });
  expect(viewer.sentry.reports).toHaveLength(1);
  expect(viewer.sentry.reports[0]).toMatchObject({
    type: "exception",
    error: { name: "CdpFault", kind: "frame" },
    context: {
      contexts: {
        browser_recovery: { outcome: "exhausted" },
        browser_connection: {
          source: "native-close",
          role: "frames",
          phase: "open",
          code: 1006,
          was_clean: false,
        },
      },
    },
  });
  expect(JSON.stringify(viewer.sentry.reports)).not.toContain("private");
  expect(viewer.errorLogs()).toHaveLength(0);
  click(retry);
  await ready();
  expect(viewer.sentry.reports).toHaveLength(1);
});

test("Manual recovery serializes its transient failures with automatic policy", async () => {
  const viewer = mockViewer();
  let phase: "denied" | "temporary" | "ready" = "denied";
  let reads = 0;
  const temporary = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, ({ respond }) => {
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
      viewer: {
        browser: viewer.session(),
        cdpUrl: endpoint,
        extension: TEST_BROWSER_EXTENSION,
      },
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
  expect(viewer.sentry.reports).toHaveLength(0);
  expect(viewer.errorLogs()).toHaveLength(0);
});

test("Selecting another tab cancels held automatic image recovery and old pixels", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
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
    const canvas =
      screen.getByLabelText<HTMLCanvasElement>("Live browser view");
    const clear = vi.spyOn(canvas.getContext("2d")!, "clearRect");
    const attachment = viewer.browser.holdNext("Target.attachToTarget");
    act(() => {
      viewer.browser.disconnect({ code: 1006, wasClean: false });
    });
    await pendingRecovery();
    viewer.advance(1000);
    await act(async () => {
      await attachment.received;
    });
    const fresh = viewer.browser.holdTargetFrames("sibling");
    act(() => {
      if (replacement === "binding") {
        viewer.replaceBinding();
        context.mocks.ably.trigger("browserSessionChanged", { threadId });
      } else {
        window.history.pushState(null, "", `/browsers/${nextThreadId}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    });
    await fresh.received;
    expect(clear).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    expect(screen.getByLabelText("Live browser view")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    act(() => {
      return fresh.release();
    });
    await ready("https://sibling.example");
    const cleared = clear.mock.calls.length;
    await act(async () => {
      await attachment.release();
    });
    expect(clear).toHaveBeenCalledTimes(cleared);
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

test("Unmounting during recovery clears the retained surface and cancels further attempts", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const canvas = screen.getByLabelText<HTMLCanvasElement>("Live browser view");
  const clear = vi.spyOn(canvas.getContext("2d")!, "clearRect");
  act(() => {
    return viewer.browser.disconnect({ code: 1006, wasClean: false });
  });
  await pendingRecovery();
  act(() => {
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => {
    return expect(
      screen.queryByLabelText("Remote browser viewer"),
    ).not.toBeInTheDocument();
  });
  expect(clear).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
  expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
  viewer.advance(180_000);
  expect(viewer.browser.connections()).toBe(1);
  expect(viewer.browser.activeConnections()).toBe(0);
  expect(viewer.sentry.reports).toHaveLength(0);
  expect(viewer.errorLogs()).toHaveLength(0);
});

test.each(
  (["input", "navigation", "creation"] as const).flatMap((effect) => {
    return (["connection", "worker"] as const).map((loss) => {
      return { effect, loss };
    });
  }),
)(
  "Automatic recovery never replays uncertain $effect after $loss loss",
  async ({ effect, loss }) => {
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
      if (loss === "worker") {
        viewer.browser.resetWorker();
      } else {
        viewer.browser.disconnect({ code: 1006, wasClean: false });
      }
    });
    await pendingRecovery();
    expect(viewer.sentry.reports).toStrictEqual([]);
    expect(viewer.errorLogs()).toHaveLength(0);
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
    expect(viewer.sentry.reports).toHaveLength(0);
    expect(viewer.errorLogs()).toHaveLength(0);
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
  expect(viewer.sentry.reports).toHaveLength(1);
  expect(viewer.sentry.reports[0]).toMatchObject({
    error: {
      name: "CdpFault",
      kind: "unsupported-capability",
      request: { method: "Page.enable", code: -32_601 },
    },
    context: { contexts: { browser_recovery: { outcome: "terminal" } } },
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
  await waitFor(() => {
    expect(viewer.sentry.reports).toHaveLength(1);
  });
  expect(viewer.sentry.reports[0]).toMatchObject({
    error: { kind: "scope" },
    context: {
      contexts: {
        browser_recovery: { outcome: "terminal" },
        browser_window: {
          source: "native-window-removed",
          instanceId: "22222222-2222-4222-8222-222222222222",
          primaryWindowId: 101,
        },
      },
    },
  });
  expect(JSON.stringify(viewer.sentry.reports)).not.toContain("private");
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
      context.mocks.http.get(`*/api/chat-threads/${threadId}/browser`, () => {
        if (!unavailable) {
          return;
        }
        unavailable = false;
        failed.resolve();
        return HttpResponse.error();
      });
    } else {
      context.mocks.api(browserContract.get, ({ respond }) => {
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
          viewer: {
            browser: viewer.session(),
            cdpUrl: endpoint,
            extension: TEST_BROWSER_EXTENSION,
          },
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
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
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
  expect(viewer.sentry.reports).toHaveLength(1);
  expect(viewer.sentry.reports[0]).toMatchObject({
    type: "exception",
    error: { name: "NavigationFault" },
    context: { tags: { logger: "Promise" } },
  });
  expect(viewer.errorLogs()).toHaveLength(1);
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
    const stops = viewer.browser.requests.filter((request) => {
      return request.method === "Page.stopScreencast";
    }).length;
    viewer.advance(31_000);
    await waitFor(() => {
      expect(
        viewer.browser.requests.filter((request) => {
          return request.method === "Page.stopScreencast";
        }).length,
      ).toBeGreaterThan(stops);
    });
    await act(() => {
      image.release();
    });
  }
}

async function exhaustImageRecovery(viewer: ReturnType<typeof mockViewer>) {
  await failImageAttempts(viewer, 3);
  const retry = await screen.findByText("Retry live image", {
    selector: "button",
  });
  await waitFor(() => {
    expect(retry).toBeEnabled();
  });
}

test("Repeated missing retry images recover locally within the original budget", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const canvas = screen.getByLabelText<HTMLCanvasElement>("Live browser view");
  const clear = vi.spyOn(canvas.getContext("2d")!, "clearRect");
  const connections = viewer.browser.connections();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  await failImageAttempts(viewer, 2);
  expect(clear).not.toHaveBeenCalled();
  viewer.advance(4000);
  await ready();
  await insertText("after repeated missing images");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)?.params).toMatchObject({
      text: "after repeated missing images",
    });
  });
  expect(viewer.browser.connections()).toBe(connections);
  expect(clear).not.toHaveBeenCalled();
});

test("Exhausted local image recovery permits a new manual image retry", async () => {
  const viewer = mockViewer();
  await viewer.start();
  await ready();
  const connections = viewer.browser.connections();
  act(() => {
    viewer.browser.frame("!");
  });
  await pendingRecovery();
  await failImageAttempts(viewer, 3);
  const retry = await screen.findByText("Retry live image", {
    selector: "button",
  });
  await waitFor(() => {
    expect(retry).toBeEnabled();
  });
  expect(viewer.sentry.reports).toHaveLength(1);
  expect(viewer.sentry.reports[0]).toMatchObject({
    context: { contexts: { browser_recovery: { outcome: "exhausted" } } },
  });
  click(retry);
  await ready();
  await insertText("after exhausted image recovery");
  await waitFor(() => {
    expect(viewer.browser.input.at(-1)?.params).toMatchObject({
      text: "after exhausted image recovery",
    });
  });
  expect(viewer.sentry.reports).toHaveLength(1);
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
  await pendingRecovery();
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
  await pendingRecovery();
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
  context.mocks.api(browserContract.get, ({ respond }) => {
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
          viewer: {
            browser: viewer.session(),
            cdpUrl: endpoint,
            extension: TEST_BROWSER_EXTENSION,
          },
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
