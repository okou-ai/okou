import {
  browserContract,
  type BrowserViewerConnection,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  promptEvent,
  assistantEvent,
  completedEvent,
} from "./chat-run-test-fixtures.ts";

const nativeUrl = "wss://browser.example.test/session79";
export async function openBrowserChat(
  context: TestContext,
  initial: "live" | "stopped" | "denied",
  holdResume = false,
  options: {
    many?: boolean;
    working?: boolean;
    completed?: boolean;
    mobile?: boolean;
  } = {},
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
    targets: Array.from({ length: options.many ? 12 : 1 }, (_, i) => {
      return {
        targetId: i === 0 ? "review-page" : "page-" + String(i + 1),
        title:
          i === 0
            ? options.many
              ? "Example"
              : "Invoices"
            : "Page " + String(i + 1),
        url:
          i === 0
            ? "https://billing.example.test/invoices"
            : "https://page" + String(i + 1) + ".example",
        windowId: 112,
      };
    }),
  });
  const closedThreads: string[] = [];
  context.mocks.api(browserContract.close, ({ params, respond }) => {
    closedThreads.push(params.threadId);
    status = "stopped";
    return respond(200, {});
  });
  const reply =
    "Please sign in to the billing site. [View the browser](" +
    surface.viewerUrl +
    ")";
  if (options.working || options.completed) {
    const runId = crypto.randomUUID(),
      events = [
        promptEvent({
          id: crypto.randomUUID(),
          runId,
          seqId: 1,
          text: "Download last month's invoices",
        }),
        assistantEvent({
          id: crypto.randomUUID(),
          runId,
          seqId: 2,
          text: reply,
        }),
      ];
    if (options.completed) {
      events.push(completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }));
    }
    mockChatLifecycle(context, {
      threadId: RUN_THREAD_ID,
      cloudBrowserEnabled: true,
      activeRunIds: options.working ? [runId] : [],
      chatEvents: events,
    });
  } else {
    createChatCapabilityHelpers(context).installCapabilityChat({
      events: completedConversation(reply),
      cloudBrowserEnabled: true,
    });
  }
  if (options.mobile) {
    context.mocks.browser.standaloneDisplayMode(true);
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    );
  }
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
    closedThreads,
    open,
    cdp,
    resumed,
    release,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}
export async function remoteBrowserInput() {
  return await waitFor(() => {
    const input = screen.getByRole("textbox", { name: "Remote browser input" });
    expect(input).toBeEnabled();
    return input;
  });
}
