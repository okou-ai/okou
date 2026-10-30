import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("A failed split transport releases its first socket and can reconnect", async () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const cdpUrl = "wss://browser.example/acquisition";
  const session: BrowserSession = {
    threadId,
    name: "booking",
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
  mockBrowserCdp(context, cdpUrl);
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: session });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  const NativeWebSocket = globalThis.WebSocket;
  const connections: WebSocket[] = [];
  const partialConnections: WebSocket[] = [];
  let rejectAdditionalConnection = false;
  vi.spyOn(globalThis, "WebSocket").mockImplementation(
    class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        // Keep the external failure active across StrictMode's ref replay.
        if (
          rejectAdditionalConnection &&
          connections.some((socket) => {
            return socket.readyState !== WebSocket.CLOSED;
          })
        ) {
          throw new DOMException(
            "The image socket is unavailable",
            "SecurityError",
          );
        }
        super(url, protocols);
        connections.push(this);
        if (rejectAdditionalConnection) {
          partialConnections.push(this);
        }
      }
    },
  );

  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.click(await screen.findByText("Connection mode"));
  const menu = await screen.findByRole("menu", { name: "Connection mode" });
  const split = queryAllByRoleFast("menuitemradio", menu).find((item) => {
    return item.textContent?.trim() === "Separate image connection";
  });
  if (!split) {
    throw new Error("Missing split transport option");
  }
  rejectAdditionalConnection = true;
  await userEvent.click(split);
  await expect(
    screen.findByText("Browser view unavailable"),
  ).resolves.toBeInTheDocument();
  expect(partialConnections.length).toBeGreaterThan(0);
  for (const socket of partialConnections) {
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  }
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();

  const reconnect = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Reconnect";
  });
  if (!reconnect) {
    throw new Error("Missing reconnect control");
  }
  rejectAdditionalConnection = false;
  await userEvent.click(reconnect);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});
