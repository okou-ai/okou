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
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

async function setupViewer() {
  let box = new DOMRect(0, 0, 1440, 900);
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this instanceof HTMLCanvasElement ? box : original.call(this);
    },
  );
  const session: BrowserSession = {
    threadId,
    name: "touch",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  const cdpUrl = "wss://browser.example/touch";
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
    return respond(200, { browser: session });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  const proxy = screen.getByLabelText("Remote browser input");
  await waitFor(() => {
    return expect(proxy).toBeEnabled();
  });
  const canvas = screen.getByRole("img", { name: "Live browser view" });
  const surface = canvas.parentElement!;
  return {
    browser,
    proxy,
    surface,
    setBox: (next: DOMRect) => {
      box = next;
    },
  };
}

function touch(
  surface: HTMLElement,
  type: string,
  x: number,
  y: number,
  {
    pointerId = 1,
    isPrimary = true,
  }: Pick<PointerEventInit, "pointerId" | "isPrimary"> = {},
) {
  fireEvent(
    surface,
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      pointerId,
      isPrimary,
      clientX: x,
      clientY: y,
    }),
  );
}

test("A touch tap with small finger jitter clicks once despite compatibility mouse events", async () => {
  const { browser, proxy, surface } = await setupViewer();
  touch(surface, "pointerdown", 720, 450);
  touch(surface, "pointermove", 723, 454);
  touch(surface, "pointerup", 723, 454);
  fireEvent.mouseDown(surface, {
    clientX: 723,
    clientY: 454,
    button: 0,
    buttons: 1,
  });
  fireEvent.mouseUp(surface, { clientX: 723, clientY: 454, button: 0 });
  await waitFor(() => {
    return expect(browser.input).toHaveLength(2);
  });
  expect(browser.input).toStrictEqual([
    {
      method: "Input.dispatchMouseEvent",
      sessionId: "example-page-session",
      params: {
        type: "mousePressed",
        x: 723,
        y: 454,
        button: "left",
        buttons: 1,
        modifiers: 0,
        clickCount: 1,
      },
    },
    {
      method: "Input.dispatchMouseEvent",
      sessionId: "example-page-session",
      params: {
        type: "mouseReleased",
        x: 723,
        y: 454,
        button: "left",
        buttons: 0,
        modifiers: 0,
        clickCount: 1,
      },
    },
  ]);
  expect(proxy).toHaveFocus();
});

test("A swipe routes finger-opposed scrolling to its starting region without a click or keyboard focus", async () => {
  const { browser, proxy, surface } = await setupViewer();
  touch(surface, "pointerdown", 720, 600);
  touch(surface, "pointermove", 700, 560);
  touch(surface, "pointerup", 680, 500);
  await waitFor(() => {
    return expect(browser.input).toHaveLength(1);
  });
  expect(browser.input[0]).toMatchObject({
    method: "Input.dispatchMouseEvent",
    sessionId: "example-page-session",
    params: {
      type: "mouseWheel",
      x: 720,
      y: 600,
      buttons: 0,
      deltaX: 40,
      deltaY: 100,
    },
  });
  expect(proxy).not.toHaveFocus();
});

test.each(["pointercancel", "lostpointercapture", "second-finger"])(
  "%s cancels a pending gesture and a fresh tap remains usable",
  async (reason) => {
    const { browser, surface } = await setupViewer();
    touch(surface, "pointerdown", 720, 600);
    touch(surface, "pointermove", 720, 560);
    if (reason === "second-finger") {
      touch(surface, "pointerdown", 760, 600, {
        pointerId: 2,
        isPrimary: false,
      });
    } else {
      touch(surface, reason, 720, 560);
    }
    touch(surface, "pointerup", 720, 560);
    touch(surface, "pointerdown", 720, 450, { pointerId: 3 });
    touch(surface, "pointerup", 720, 450, { pointerId: 3 });
    await waitFor(() => {
      return expect(browser.input).toHaveLength(2);
    });
    expect(
      browser.input.map((request) => {
        return request.params;
      }),
    ).toStrictEqual([
      expect.objectContaining({ type: "mousePressed", x: 720, y: 450 }),
      expect.objectContaining({ type: "mouseReleased", x: 720, y: 450 }),
    ]);
  },
);

test("Touch starting in letterbox space is ignored while the mapped image remains clickable", async () => {
  const { browser, surface, setBox } = await setupViewer();
  setBox(new DOMRect(0, 0, 1440, 1200));
  touch(surface, "pointerdown", 720, 20);
  touch(surface, "pointerup", 720, 20);
  touch(surface, "pointerdown", 720, 600);
  touch(surface, "pointerup", 720, 600);
  await waitFor(() => {
    return expect(browser.input).toHaveLength(2);
  });
  expect(browser.input[1]).toMatchObject({
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseReleased", x: 720, y: 450 },
  });
});

test("A touch from the old tab cannot click the newly selected tab", async () => {
  const { browser, surface } = await setupViewer();
  touch(surface, "pointerdown", 720, 450);
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  touch(surface, "pointerup", 720, 450);
  touch(surface, "pointerdown", 720, 450, { pointerId: 3 });
  touch(surface, "pointerup", 720, 450, { pointerId: 3 });
  await waitFor(() => {
    return expect(browser.input).toHaveLength(2);
  });
  expect(
    browser.input.every((request) => {
      return request.sessionId === "other-page-session";
    }),
  ).toBeTruthy();
});

test("A document change discards a pending swipe before another touch is admitted", async () => {
  const { browser, surface } = await setupViewer();
  touch(surface, "pointerdown", 720, 600);
  touch(surface, "pointermove", 720, 560);
  act(() => {
    return browser.event(
      "Page.navigatedWithinDocument",
      { frameId: "example-frame", url: "https://example.com/#new" },
      "example-page-session",
    );
  });
  touch(surface, "pointerup", 720, 560);
  touch(surface, "pointerdown", 720, 450, { pointerId: 3 });
  touch(surface, "pointerup", 720, 450, { pointerId: 3 });
  await waitFor(() => {
    return expect(browser.input).toHaveLength(2);
  });
  expect(browser.input[1]).toMatchObject({ params: { type: "mouseReleased" } });
});

test("Desktop mouse click and wheel input keep their existing behavior", async () => {
  const { browser, surface } = await setupViewer();
  await userEvent.pointer([
    {
      target: surface,
      coords: { clientX: 720, clientY: 450 },
      keys: "[MouseLeft]",
    },
  ]);
  fireEvent.wheel(surface, { clientX: 720, clientY: 450, deltaY: 90 });
  await waitFor(() => {
    return expect(browser.input).toHaveLength(3);
  });
  expect(
    browser.input.map((request) => {
      return request.params;
    }),
  ).toStrictEqual([
    expect.objectContaining({ type: "mousePressed" }),
    expect.objectContaining({ type: "mouseReleased" }),
    expect.objectContaining({ type: "mouseWheel", deltaY: 90 }),
  ]);
});
