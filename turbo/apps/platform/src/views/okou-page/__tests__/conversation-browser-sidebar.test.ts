import {
  browserContract,
  type BrowserViewerConnection,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import {
  createChatCapabilityHelpers,
  completedConversation,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-capability-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();

const nativeUrl = "wss://browser.example.test/session79";
async function conversation(
  initial: "live" | "stopped" | "denied",
  holdResume = false,
) {
  const denied = {
    error: {
      code: "BROWSER_AUTHORIZATION_REQUIRED",
      message: "Cloud browser is not enabled for this chat",
    },
  };
  const resumed = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let status = initial;
  const time = "2026-11-20T12:00:00.000Z";
  const surface = {
    threadId: RUN_THREAD_ID,
    name: "Review browser",
    viewerUrl: "https://app.okou.ai/browsers/" + RUN_THREAD_ID,
    liveUrl: null,
    screenshotUrl: null,
    timeoutMinutes: 10,
    idleExpiresAt: null,
    suspendedAt: null,
    suspensionReason: null,
    createdAt: time,
    updatedAt: time,
  };
  const viewer: BrowserViewerConnection = {
    browser: {
      ...surface,
      status: "active",
      window: {
        instanceId: "bc790000-0000-4000-a000-000000000001",
        primaryWindowId: 112,
      },
    },
    cdpUrl: nativeUrl,
    extension: TEST_BROWSER_EXTENSION,
  };
  const stopped: BrowserSession = {
    ...surface,
    status: "suspended",
    suspendedAt: time,
    suspensionReason: "idle",
  };
  const cdp = mockBrowserCdp(context, nativeUrl, {
    targets: [
      {
        targetId: "review-page",
        title: "Invoices",
        url: "https://billing.example.test/invoices",
        windowId: 112,
      },
    ],
  });
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation(
      "Open the billing site. [View the browser](" + surface.viewerUrl + ")",
    ),
    cloudBrowserEnabled: true,
  });
  context.mocks.api(browserContract.get, ({ query, respond }) => {
    if (status === "denied") {
      return respond(403, denied);
    }
    if (status === "stopped") {
      return respond(200, { browser: stopped, viewer: null });
    }
    return respond(200, {
      browser: viewer.browser,
      viewer: query?.viewer === "native" ? viewer : null,
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return status === "denied"
      ? respond(403, denied)
      : respond(200, { browser: status === "live" ? viewer.browser : stopped });
  });
  context.mocks.api(browserContract.open, async ({ respond }) => {
    if (status === "denied") {
      return respond(403, denied);
    }
    if (holdResume) {
      resumed.resolve();
      await release.promise;
    }
    status = "live";
    return respond(200, { browser: viewer.browser, viewer });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });
  const card = await screen.findByTestId("browser-session-card-shell");
  const open = await waitFor(() => {
    const b = card.querySelector<HTMLButtonElement>(
      "button[data-browser-session-card]",
    );
    if (!b || b.disabled) {
      throw new Error("Browser card is not interactive: " + card.textContent);
    }
    return b;
  });
  return {
    card,
    open,
    cdp,
    resumed,
    release,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}
async function remote() {
  return await waitFor(() => {
    const input = screen.getByRole("textbox", { name: "Remote browser input" });
    expect(input).toBeEnabled();
    return input;
  });
}
test("chat-navigation-browser-003 A denied Browser card opens an authorization placeholder while the original card stays visible", async () => {
  const { card, open } = await conversation("denied");
  click(open);
  const close = await findFastControl("button", /close.*browser/i);
  expect(close).toBeEnabled();
  expect(card).toBeVisible();
  await expect(
    screen.findAllByText("Cloud browser is not enabled for this chat"),
  ).resolves.toHaveLength(2);
  expect(
    screen.queryByRole("textbox", { name: "Remote browser input" }),
  ).toBeNull();
  expect(screen.queryByText("Browser not live")).toBeNull();
});
test("chat-navigation-browser-026 Opening a stopped Browser from chat exposes Start browser", async () => {
  const { open } = await conversation("stopped");
  expect(screen.queryByText("Browser not live")).toBeNull();
  click(open);
  await screen.findByText("Browser not live");
  await expect(
    findFastControl("button", "Start browser"),
  ).resolves.toBeEnabled();
});
test("chat-navigation-browser-001 A reclaimed Browser resumes from its live summary and sends typed input to the resumed page", async () => {
  const { open, setStatus, cdp, resumed, release } = await conversation(
    "live",
    true,
  );
  expect(open).toHaveAttribute("data-browser-session-status", "active");
  setStatus("stopped");
  click(open);
  try {
    await resumed.promise;
    expect(
      screen
        .queryByRole("textbox", { name: "Remote browser input" })
        ?.matches(":enabled") ?? false,
    ).toBeFalsy();
    release.resolve();
    const input = await remote();
    await userEvent.setup({ delay: null }).type(input, "r");
    await waitFor(() => {
      return expect(cdp.inputForTarget("review-page")).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "Input.dispatchKeyEvent",
            params: expect.objectContaining({ text: "r" }),
          }),
        ]),
      );
    });
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});
test("chat-navigation-browser-002 Reopening the previously started Browser rechecks authorization before exposing the viewer", async () => {
  const { open, setStatus } = await conversation("stopped");
  click(open);
  click(await findFastControl("button", "Start browser"));
  await remote();
  setStatus("denied");
  click(await findFastControl("button", /close.*browser/i));
  await waitFor(() => {
    return expect(
      screen.queryByRole("textbox", { name: "Remote browser input" }),
    ).toBeNull();
  });
  click(open);
  await waitFor(() => {
    return expect(
      screen.getAllByText("Cloud browser is not enabled for this chat"),
    ).toHaveLength(2);
  });
  expect(
    screen.queryByRole("textbox", { name: "Remote browser input" }),
  ).toBeNull();
});
