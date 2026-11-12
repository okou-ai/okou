import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  maximumCdpMessageLength,
  maximumEncodedFrameLength,
} from "../../../signals/browser/display/limits.ts";

import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

function button(name: string, container: ParentNode = document.body) {
  const found = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!found) {
    throw new Error(`Missing button: ${name}`);
  }
  return found;
}

async function setupViewer() {
  const browser: BrowserSession = {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    proxyCountryCode: null,
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
  const cdpUrl = "wss://browser.example/frame-budgets";
  const remote = mockBrowserCdp(context, cdpUrl);
  const firstImage = remote.holdFrames("example-page-session");
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: browser,
      viewer: {
        browser,
        cdpUrl,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser });
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await firstImage.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  return { remote, firstImage };
}

async function expectReady() {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
}

test.each(["shared", "split"] as const)(
  "A %s viewer accepts a 48 MiB first image and enables remote input",
  async (transport) => {
    const { remote, firstImage } = await setupViewer();
    let image = firstImage;
    if (transport === "split") {
      act(() => {
        firstImage.release();
      });
      await expectReady();
      image = remote.holdTargetFrames("example-page");
      click(button("Browser settings"));
      click(await screen.findByText("Connection mode"));
      const menu = await screen.findByRole("menu", { name: "Connection mode" });
      const separate = queryAllByRoleFast("menuitemradio", menu).find(
        (candidate) => {
          return candidate.textContent?.trim() === "Separate image connection";
        },
      );
      if (!separate) {
        throw new Error("Missing separate image connection option");
      }
      click(separate);
      await image.received;
    }
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      image.release("A".repeat(48 * 1024 * 1024));
    });
    await expectReady();
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toHaveAttribute("width", "1440");
  },
);

test("A frame above its budget retains the connection and recovers its image automatically", async () => {
  const advanceRecovery = browserRecoveryClock(context.signal);
  const { remote, firstImage } = await setupViewer();
  act(() => {
    firstImage.release();
  });
  await expectReady();
  act(() => {
    remote.frame("A".repeat(maximumEncodedFrameLength + 4));
  });
  await screen.findByText("Reconnecting…");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  advanceRecovery(1000);
  await expectReady();
});

test("A message above its budget disconnects and supports explicit reconnect", async () => {
  const { remote, firstImage } = await setupViewer();
  act(() => {
    firstImage.release();
  });
  await expectReady();
  act(() => {
    remote.event("Runtime.consoleAPICalled", {
      data: "A".repeat(maximumCdpMessageLength + 1),
    });
  });
  await screen.findByText("Browser disconnected");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(button("Reconnect"));
  await expectReady();
});
