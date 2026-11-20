import {
  browserContract,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListStream,
} from "../../okou-page/__tests__/chat-list-test-helpers.ts";

const context = testContext();
const caseId = 805;
const blocked = "Cloud browser is not enabled for this chat";
const owned = "https://owned.example";

function arrangeAcquisition(initial: "active" | "suspended") {
  const thread = chatListThread(1, "Shared browser", {
    cloudBrowserEnabled: true,
  });
  const path = `/browsers/${thread.id}`;
  const cdpUrl = "wss://cdp.example.test/acquire";
  const time = "2026-08-01T10:00:00.000Z";
  const base = {
    threadId: thread.id,
    name: "Shared browser",
    viewerUrl: `https://app.okou.ai${path}`,
    liveUrl: null,
    screenshotUrl: null,
    timeoutMinutes: 10,
    idleExpiresAt: null,
    createdAt: time,
    updatedAt: time,
  };
  const viewer: BrowserViewerConnection = {
    browser: {
      ...base,
      status: "active",
      suspendedAt: null,
      suspensionReason: null,
      window: {
        instanceId: "a0000000-0000-4000-a000-000000000805",
        primaryWindowId: 1,
      },
    },
    cdpUrl,
    extension: TEST_BROWSER_EXTENSION,
  };
  const suspended = {
    ...base,
    status: "suspended" as const,
    suspendedAt: time,
    suspensionReason: "idle" as const,
  };
  const cdp = mockBrowserCdp(context, cdpUrl, {
    targets: [
      { targetId: "owned-page", title: "Owned page", url: owned, windowId: 1 },
    ],
  });
  const stream = installChatListStream(context, { caseId, snapshot: [thread] });
  const notices: ReturnType<typeof chatListEvent>[] = [];
  const counts = { reads: 0, opens: 0 };
  const server = {
    status: initial as "active" | "suspended" | "denied",
    viewer,
  };
  const unavailable = {
    error: {
      code: "BROWSER_UNAVAILABLE",
      message: "Explicit opening unavailable",
    },
  };
  context.mocks.api(browserContract.get, ({ query, respond }) => {
    expect(query?.viewer).toBe("native");
    counts.reads += 1;
    if (server.status === "denied") {
      return respond(403, {
        error: { code: "BROWSER_AUTHORIZATION_REQUIRED", message: blocked },
      });
    }
    return server.status === "suspended"
      ? respond(200, { browser: suspended, viewer: null })
      : respond(200, { browser: server.viewer.browser, viewer: server.viewer });
  });
  context.mocks.api(browserContract.open, ({ respond }) => {
    counts.opens += 1;
    return respond(503, unavailable);
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: server.viewer.browser });
  });

  function publish(operationId?: string) {
    context.mocks.ably.trigger("browserSessionChanged", {
      threadId: thread.id,
      ...(operationId ? { operationId } : {}),
    });
  }

  return {
    cdp,
    counts,
    server,
    publish,
    openPage: async () => {
      await setupPage({
        context,
        path,
        host: "app.okou.ai",
        featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
        cachedChatThreadEvents: cachedChatListEvents(caseId, [thread]),
      });
      await waitFor(() => {
        expect(
          context.mocks.ably.hasSubscription("browserSessionChanged"),
        ).toBeTruthy();
      });
    },
    access(enabled: boolean) {
      notices.push(
        chatListEvent(
          caseId,
          notices.length + 2,
          "computer_use_host_updated",
          thread.id,
          {
            computerUseHostId: null,
            cloudBrowserEnabled: enabled,
          },
        ),
      );
      server.status = enabled ? "active" : "denied";
      stream.setEvents(notices);
      changeChatThreadList();
    },
  };
}

async function expectLiveInput(
  cdp: ReturnType<typeof mockBrowserCdp>,
  text: string,
) {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Address")).toHaveValue(owned);
  });
  const input = screen.getByLabelText("Remote browser input");
  input.focus();
  fireEvent.input(input, {
    target: { value: text },
    data: text,
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(cdp.input).toContainEqual({
      method: "Input.insertText",
      params: { text },
      sessionId: cdp.pageSession("owned-page"),
    });
  });
}

test.each([
  { label: "without a lifecycle echo", echo: false },
  { label: "with one correlated lifecycle echo", echo: true },
])(
  "Use Start's returned connection while acquisition is stalled $label",
  async ({ echo }) => {
    const { cdp, counts, server, publish, openPage } =
      arrangeAcquisition("suspended");
    const furtherRead = context.mocks.deferred<void>();
    context.mocks.api(browserContract.get, async ({ respond }) => {
      counts.reads += 1;
      if (counts.opens > 0) {
        await furtherRead.promise;
      }
      const { window: _window, ...inactive } = server.viewer.browser;
      return respond(200, {
        browser: {
          ...inactive,
          status: "suspended",
          suspendedAt: inactive.updatedAt,
          suspensionReason: "idle",
        },
        viewer: null,
      });
    });
    context.mocks.api(browserContract.open, ({ body, query, respond }) => {
      counts.opens += 1;
      expect(query?.viewer).toBe("native");
      expect(body.operationId).toStrictEqual(expect.any(String));
      if (echo) {
        publish(body.operationId);
      }
      return respond(200, {
        browser: server.viewer.browser,
        viewer: server.viewer,
      });
    });
    await openPage();

    click(await screen.findByText("Start browser"));

    await expectLiveInput(cdp, "from Start");
    expect(counts.opens).toBe(1);
  },
);

test("Retire the operation ID after an unrelated notice invalidates Start", async () => {
  const { cdp, counts, server, publish, openPage } =
    arrangeAcquisition("suspended");
  const deniedRead = context.mocks.deferred<void>();
  const originalOpen = context.mocks.deferred<string>();
  const finishOpen = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, ({ respond }) => {
    counts.reads += 1;
    if (server.status === "denied") {
      if (!deniedRead.settled()) {
        deniedRead.resolve();
      }
      return respond(403, {
        error: { code: "BROWSER_AUTHORIZATION_REQUIRED", message: blocked },
      });
    }
    if (server.status === "suspended") {
      const { window: _window, ...inactive } = server.viewer.browser;
      return respond(200, {
        browser: {
          ...inactive,
          status: "suspended",
          suspendedAt: inactive.updatedAt,
          suspensionReason: "idle",
        },
        viewer: null,
      });
    }
    return respond(200, {
      browser: server.viewer.browser,
      viewer: server.viewer,
    });
  });
  context.mocks.api(browserContract.open, async ({ body, respond }) => {
    counts.opens += 1;
    if (counts.opens > 1) {
      return respond(503, {
        error: {
          code: "BROWSER_UNAVAILABLE",
          message: "Explicit opening unavailable",
        },
      });
    }
    if (!body.operationId) {
      throw new Error("Start did not send its lifecycle operation ID");
    }
    originalOpen.resolve(body.operationId);
    server.status = "denied";
    publish();
    await finishOpen.promise;
    return respond(200, {
      browser: server.viewer.browser,
      viewer: server.viewer,
    });
  });
  await openPage();
  click(await screen.findByText("Start browser"));
  const id = await originalOpen.promise;
  await deniedRead.promise;
  await expect(screen.findByText(blocked)).resolves.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();

  finishOpen.resolve();
  server.status = "active";
  publish(id);

  await expectLiveInput(cdp, "after the old echo");
  expect(counts.opens).toBe(1);
});

test("Reconnect acquires a replacement when explicit opening is unavailable", async () => {
  const { cdp, counts, openPage } = arrangeAcquisition("active");
  await openPage();
  await expectLiveInput(cdp, "before disconnect");
  const session = cdp.pageSession("owned-page");
  const sockets = cdp.connections();
  cdp.event("Network.dataReceived", { payload: "A".repeat(49 * 1024 * 1024) });
  await expect(
    screen.findByText("Browser disconnected"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(await screen.findByText("Reconnect"));
  await waitFor(() => {
    expect(cdp.connections()).toBeGreaterThan(sockets);
    expect(cdp.pageSession("owned-page")).not.toBe(session);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });

  await expectLiveInput(cdp, "after reconnect");

  expect(cdp.pageSession("owned-page")).not.toBe(session);
  expect(counts.opens).toBe(0);
});

test("Acquire a fresh native connection after revoking and renewing a Start grant", async () => {
  const { cdp, counts, server, access, openPage } =
    arrangeAcquisition("suspended");
  context.mocks.api(browserContract.open, ({ respond }) => {
    counts.opens += 1;
    if (counts.opens > 1) {
      return respond(503, {
        error: {
          code: "BROWSER_UNAVAILABLE",
          message: "Explicit opening unavailable",
        },
      });
    }
    return respond(200, {
      browser: server.viewer.browser,
      viewer: server.viewer,
    });
  });
  await openPage();
  click(await screen.findByText("Start browser"));
  await expectLiveInput(cdp, "before revocation");
  const oldSession = cdp.pageSession("owned-page");

  access(false);
  await expect(screen.findByText(blocked)).resolves.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();

  server.viewer = {
    ...server.viewer,
    browser: {
      ...server.viewer.browser,
      window: {
        ...server.viewer.browser.window,
        instanceId: "a0000000-0000-4000-a000-000000000806",
      },
    },
  };
  const beforeGrant = counts.reads;
  access(true);

  await expectLiveInput(cdp, "after regrant");
  expect(cdp.pageSession("owned-page")).not.toBe(oldSession);
  expect(counts.reads).toBeGreaterThan(beforeGrant);
  expect(counts.opens).toBe(1);
});
