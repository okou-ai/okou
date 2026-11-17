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
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import { selectDesktopHeaderAction } from "./chat-header-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000047981";

async function openSidebar() {
  await selectDesktopHeaderAction("Open browser");
  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  await waitFor(() => {
    expect(
      within(sidebar).getByLabelText("Remote browser input"),
    ).toBeEnabled();
  });
  return sidebar;
}

async function setupBrowser() {
  const sentry = context.mocks.sentry();
  initSentry();
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
  const browser: BrowserSession = {
    threadId: THREAD_ID,
    name: "shutdown",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${THREAD_ID}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    timeoutMinutes: 240,
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 0,
    },
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  const cdpUrl = "wss://browser.example/shutdown";
  const native = mockBrowserCdp(context, cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 0,
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ query, respond }) => {
    return respond(200, {
      browser,
      ...(query?.viewer === "native"
        ? { viewer: { browser, cdpUrl, extension: TEST_BROWSER_EXTENSION } }
        : {}),
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser });
  });
  context.mocks.api(browserContract.close, ({ respond }) => {
    // Closing the viewer saves remote state; the original window can be reopened.
    return respond(200, {});
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Browser shutdown",
    cloudBrowserEnabled: true,
    chatEvents: [],
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });
  const sidebar = await openSidebar();
  const input = within(sidebar).getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(native.input.at(-1)).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Shift" },
    });
  });
  return { native, sentry, sidebar, input };
}

function inputErrors(sentry: ReturnType<typeof context.mocks.sentry>) {
  return sentry.reports.flatMap((report) => {
    return report.type === "exception" &&
      report.error instanceof Error &&
      report.error.message === "Original input cleanup is unconfirmed."
      ? [report.error]
      : [];
  });
}

function closeSidebar(sidebar: HTMLElement) {
  click(within(sidebar).getByLabelText("Close cloud browser"));
}

test("Closing the sidebar confirms its original key release before same-browser reuse", async () => {
  const { native, sentry, sidebar, input } = await setupBrowser();
  const originalSession = native.pageSession("example-page");
  const originalConnections = native.connections();
  const release = native.holdNext("Input.dispatchKeyEvent");
  const capture = native.holdNext("Page.stopScreencast");
  native.holdNext("Runtime.removeBinding");
  closeSidebar(sidebar);
  await release.received;
  await waitFor(() => {
    return expect(sidebar).not.toBeInTheDocument();
  });
  expect(native.activeConnections()).toBeGreaterThan(0);
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();

  await selectDesktopHeaderAction("Open browser");
  const reopened = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  expect(
    within(reopened).getByLabelText("Remote browser input"),
  ).toBeDisabled();
  expect(native.connections()).toBe(originalConnections);
  await act(release.release);
  await waitFor(() => {
    expect(
      within(reopened).getByLabelText("Remote browser input"),
    ).toBeEnabled();
  });
  await act(capture.release);
  const successor = within(reopened).getByLabelText("Remote browser input");
  fireEvent.keyUp(input, { key: "Shift", code: "ShiftLeft" });
  await userEvent.click(successor);
  fireEvent.input(successor, {
    target: { value: "fresh successor" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(native.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "fresh successor" },
    });
  });
  expect(
    native.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toMatchObject([
    {
      sessionId: originalSession,
      params: { type: "rawKeyDown", key: "Shift" },
    },
    { sessionId: originalSession, params: { type: "keyUp", key: "Shift" } },
  ]);
  expect(inputErrors(sentry)).toStrictEqual([]);
});

test("A silent original key release cannot retain a normally closed browser indefinitely", async () => {
  const { native, sentry, sidebar } = await setupBrowser();
  const originalSession = native.pageSession("example-page");
  const release = native.holdNext("Input.dispatchKeyEvent");
  native.holdNext("Page.stopScreencast");
  const closed = context.mocks.deferred<void>();
  const close = WebSocket.prototype.close;
  vi.spyOn(WebSocket.prototype, "close").mockImplementation(function (
    this: WebSocket,
    code?: number,
    reason?: string,
  ) {
    close.call(this, code, reason);
    if (!closed.settled() && native.activeConnections() === 0) {
      closed.resolve();
    }
  });
  closeSidebar(sidebar);
  await release.received;
  await waitFor(() => {
    return expect(sidebar).not.toBeInTheDocument();
  });
  // Observe the real deadline through the native close, without extending test timeouts.
  await closed.promise;
  expect(native.activeConnections()).toBe(0);
  await waitFor(() => {
    expect(inputErrors(sentry)).toContainEqual(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: "Original input retirement failed.",
          cause: expect.objectContaining({
            message: "Original cleanup receipt failed: Input.dispatchKeyEvent.",
            cause: expect.objectContaining({
              message: "The connection is closed.",
            }),
          }),
        }),
      }),
    );
  });
  const reopened = await openSidebar();
  await act(release.release);
  const input = within(reopened).getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "after bounded shutdown" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(native.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "after bounded shutdown" },
    });
  });
  expect(
    native.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toMatchObject([
    { sessionId: originalSession, params: { type: "rawKeyDown" } },
    { sessionId: originalSession, params: { type: "keyUp" } },
  ]);
});

test("Normal shutdown retains an original native key-release rejection", async () => {
  const { native, sentry, sidebar } = await setupBrowser();
  native.failNext("Input.dispatchKeyEvent", "Native release refused", -32_001);
  native.holdNext("Page.stopScreencast");
  closeSidebar(sidebar);
  await waitFor(() => {
    return expect(native.activeConnections()).toBe(0);
  });
  await waitFor(() => {
    expect(inputErrors(sentry)).toContainEqual(
      expect.objectContaining({
        request: { method: "Input.dispatchKeyEvent", code: -32_001 },
        cause: expect.objectContaining({
          message: "Original input retirement failed.",
          cause: expect.objectContaining({
            message:
              "Original cleanup receipt failed: Input.dispatchKeyEvent (CDP -32001).",
          }),
        }),
      }),
    );
  });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
});

test.each(["pointer", "composition"] as const)(
  "Normal sidebar close confirms original %s cleanup independently of capture",
  async (kind) => {
    const { native, sentry, sidebar, input } = await setupBrowser();
    if (kind === "pointer") {
      const canvas = within(sidebar).getByRole("img", {
        name: "Live browser view",
      });
      vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, 0, 1440, 900),
      );
      const point = { clientX: 100, clientY: 100, button: 0, buttons: 1 };
      fireEvent.pointerDown(canvas.parentElement!, {
        ...point,
        pointerId: 1,
        pointerType: "mouse",
      });
      fireEvent.mouseDown(canvas.parentElement!, point);
    } else {
      fireEvent.compositionStart(input);
      fireEvent.input(input, {
        target: { value: "preedit" },
        inputType: "insertCompositionText",
        isComposing: true,
      });
    }
    const method =
      kind === "pointer"
        ? "Input.dispatchMouseEvent"
        : "Input.imeSetComposition";
    await waitFor(() => {
      expect(native.input.at(-1)).toMatchObject({
        method,
        params:
          kind === "pointer" ? { type: "mousePressed" } : { text: "preedit" },
      });
    });
    const release = native.holdNext(method);
    native.holdNext("Page.stopScreencast");
    closeSidebar(sidebar);
    await release.received;
    await waitFor(() => {
      return expect(sidebar).not.toBeInTheDocument();
    });
    expect(native.activeConnections()).toBeGreaterThan(0);
    await act(release.release);
    await waitFor(() => {
      return expect(native.activeConnections()).toBe(0);
    });
    expect(
      native.input
        .filter((request) => {
          return request.method === method;
        })
        .at(-1),
    ).toMatchObject({
      method,
      params: kind === "pointer" ? { type: "mouseReleased" } : { text: "" },
    });
    expect(inputErrors(sentry)).toStrictEqual([]);
  },
);
