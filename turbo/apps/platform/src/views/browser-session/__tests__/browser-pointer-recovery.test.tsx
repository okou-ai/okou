import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

async function setupViewer() {
  const session: BrowserSession = {
    threadId,
    name: "pointer recovery",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 0,
    },
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  const cdpUrl = "wss://browser.example/pointer-recovery";
  const browser = mockBrowserCdp(context, cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
      },
      {
        targetId: "other-page",
        title: "Other",
        url: "https://other.example.com",
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: session,
      viewer: { browser: session, cdpUrl, extension: TEST_BROWSER_EXTENSION },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const canvas = screen.getByRole("img", {
    name: "Live browser view",
  });
  // Pointer hit geometry must not also schedule a startup window resize.
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1440, 900),
  );
  return { browser, surface: canvas.parentElement! };
}

function moveMouse(surface: HTMLElement, buttons = 0, shiftKey = false) {
  fireEvent.pointerMove(surface, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 100,
    clientY: 100,
    buttons,
    shiftKey,
  });
}

function pressMouse(surface: HTMLElement) {
  fireEvent.pointerDown(surface, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 100,
    clientY: 100,
    button: 0,
    buttons: 1,
  });
  fireEvent.mouseDown(surface, {
    clientX: 100,
    clientY: 100,
    button: 0,
    buttons: 1,
  });
}

function detachOriginal(browser: ReturnType<typeof mockBrowserCdp>) {
  act(() => {
    browser.event("Target.detachedFromTarget", {
      sessionId: "example-page-session",
      targetId: "example-page",
    });
  });
}

function cleanupError(sentry: ReturnType<typeof context.mocks.sentry>) {
  const report = sentry.reports.find((entry) => {
    return (
      entry.type === "exception" &&
      entry.error instanceof Error &&
      entry.error.message === "Original input cleanup is unconfirmed."
    );
  });
  if (report?.type !== "exception" || !(report.error instanceof Error)) {
    throw new Error("Expected original input cleanup failure");
  }
  return report.error;
}

test.each([false, true])(
  "An unacknowledged hover recovers after its session ends (target destroyed: %s)",
  async (destroyed) => {
    const { browser, surface } = await setupViewer();
    const receipt = browser.holdNext("Input.dispatchMouseEvent");
    moveMouse(surface);
    await receipt.received;
    expect(browser.input).toStrictEqual([
      {
        method: "Input.dispatchMouseEvent",
        sessionId: "example-page-session",
        params: {
          type: "mouseMoved",
          x: 100,
          y: 100,
          button: "none",
          buttons: 0,
          modifiers: 0,
        },
      },
    ]);
    if (destroyed) {
      act(() => {
        browser.event("Target.targetDestroyed", { targetId: "example-page" });
      });
    } else {
      detachOriginal(browser);
    }
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
      expect(
        screen.getByLabelText(destroyed ? "Other" : "Example", {
          selector: '[role="tab"]',
        }),
      ).toHaveAttribute("aria-selected", "true");
    });
    await act(async () => {
      await receipt.release();
    });
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    expect(input).toHaveFocus();
    fireEvent.input(input, {
      target: { value: "fresh input" },
      inputType: "insertText",
    });
    await waitFor(() => {
      expect(browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "fresh input" },
      });
    });
    const address = screen.getByLabelText("Address");
    await fill(address, "recovered.example/ready");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue("http://recovered.example/ready");
    });
    expect(
      browser.requests.filter((entry) => {
        return (
          entry.method === "Input.dispatchMouseEvent" &&
          entry.params?.type === "mouseMoved" &&
          entry.params.x === 100 &&
          entry.params.y === 100
        );
      }),
    ).toHaveLength(1);
  },
);

test.each(["press", "release", "drag", "modified hover"])(
  "An unacknowledged mouse %s retains its original failure and same-tab fence",
  async (operation) => {
    const sentry = context.mocks.sentry();
    initSentry();
    const { browser, surface } = await setupViewer();
    if (operation === "release" || operation === "drag") {
      const pressed = browser.holdNext("Input.dispatchMouseEvent");
      pressMouse(surface);
      await pressed.received;
      await act(async () => {
        await pressed.release();
      });
    }
    const receipt = browser.holdNext("Input.dispatchMouseEvent");
    if (operation === "press") {
      pressMouse(surface);
    } else if (operation === "drag") {
      moveMouse(surface, 1);
    } else if (operation === "modified hover") {
      moveMouse(surface, 0, true);
    } else {
      fireEvent.pointerUp(surface, {
        pointerId: 1,
        pointerType: "mouse",
        clientX: 100,
        clientY: 100,
        buttons: 0,
      });
      fireEvent.mouseUp(surface, { clientX: 100, clientY: 100, button: 0 });
    }
    await receipt.received;
    detachOriginal(browser);
    await screen.findByText("Browser view unavailable");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    await waitFor(() => {
      expect(cleanupError(sentry)).toMatchObject({
        cause: {
          message: "Original input retirement failed.",
          cause: {
            message: "Original input receipt failed: Input.dispatchMouseEvent.",
            cause: { message: "The browser target session is closed." },
          },
        },
      });
    });
    await act(async () => {
      await receipt.release();
    });
    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    click(screen.getByLabelText("Example", { selector: '[role="tab"]' }));
    await screen.findByText("Browser view unavailable");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  },
);

test("A detached neutral hover cannot hide a held key's failed original release", async () => {
  const sentry = context.mocks.sentry();
  initSentry();
  const { browser, surface } = await setupViewer();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  const key = browser.holdNext("Input.dispatchKeyEvent");
  fireEvent.keyDown(input, { key: "ArrowDown", code: "ArrowDown" });
  await key.received;
  await act(async () => {
    await key.release();
  });
  const receipt = browser.holdNext("Input.dispatchMouseEvent");
  moveMouse(surface);
  await receipt.received;
  expect(browser.input.at(-1)).toMatchObject({
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseMoved", button: "none", buttons: 0, modifiers: 0 },
  });
  detachOriginal(browser);
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(cleanupError(sentry)).toMatchObject({
      cause: {
        cause: {
          message:
            "Original cleanup receipt failed: Input.dispatchKeyEvent (CDP -32001).",
        },
      },
    });
  });
  await act(async () => {
    await receipt.release();
  });
});

test("A detached neutral hover preserves an earlier native rejection", async () => {
  const sentry = context.mocks.sentry();
  initSentry();
  const { browser, surface } = await setupViewer();
  browser.failNext("Input.dispatchMouseEvent", "Native hover rejected");
  const receipt = browser.holdNext("Input.dispatchMouseEvent");
  moveMouse(surface);
  await receipt.received;
  await act(async () => {
    await receipt.release();
  });
  const hover = browser.holdNext("Input.dispatchMouseEvent");
  moveMouse(surface);
  await hover.received;
  detachOriginal(browser);
  await screen.findByText("Browser view unavailable");
  await act(async () => {
    await hover.release();
  });
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  click(screen.getByLabelText("Example", { selector: '[role="tab"]' }));
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    expect(cleanupError(sentry)).toMatchObject({
      cause: {
        cause: {
          message:
            "Original input receipt failed: Input.dispatchMouseEvent (CDP -32000).",
        },
      },
    });
  });
});
