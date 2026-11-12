import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockMonotonicNow, mockNow } from "../../../lib/time.ts";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListStream,
} from "../../okou-page/__tests__/chat-list-test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";
const endpoint = "wss://browser.example/acquisition";

function authorization() {
  let enabled = true;
  const events: ReturnType<typeof chatListEvent>[] = [];
  const snapshot = [
    chatListThread(1, "Viewer acquisition", {
      id: threadId,
      cloudBrowserEnabled: true,
    }),
  ];
  const stream = installChatListStream(context, { caseId: 45_528, snapshot });
  return {
    cachedChatThreadEvents: cachedChatListEvents(45_528, snapshot),
    enabled: () => {
      return enabled;
    },
    change(value: boolean) {
      enabled = value;
      events.push(
        chatListEvent(
          45_528,
          events.length + 2,
          "computer_use_host_updated",
          threadId,
          { cloudBrowserEnabled: value },
        ),
      );
      stream.setEvents(events);
      context.mocks.ably.trigger("threadListChanged");
    },
  };
}

function fixture(
  initial: "active" | "suspended",
  access?: ReturnType<typeof authorization>,
  onOpen?: (operationId: string | undefined) => void,
) {
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  mockNow(() => {
    return Date.parse("2026-09-01T10:00:00.000Z") + elapsed;
  }, context.signal);
  const session: BrowserSession = {
    threadId,
    name: "acquisition",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: null,
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 101,
    },
  };
  let viewer = {
    browser: session,
    cdpUrl: endpoint,
    extension: TEST_BROWSER_EXTENSION,
  };
  const nativeOptions = {
    targets: [
      {
        targetId: "first",
        title: "Owned tab",
        url: "https://owned.example",
        windowId: 101,
      },
    ],
  };
  const browser = mockBrowserCdp(context, endpoint, nativeOptions);
  let operationId: string | undefined;
  let readBarrier: Promise<void> | null = null;
  let readsDenied = false;
  let opensDenied = false;
  let active = initial === "active";
  context.mocks.api(browserContract.get, async ({ query, respond }) => {
    if (readBarrier) {
      await readBarrier;
    }
    expect(query).toStrictEqual({ viewer: "native" });
    if (readsDenied || (access && !access.enabled())) {
      return respond(403, {
        error: {
          code: "BROWSER_AUTHORIZATION_REQUIRED",
          message: "Browser permission revoked",
        },
      });
    }
    return respond(
      200,
      active
        ? { browser: session, viewer }
        : {
            browser: {
              ...session,
              status: "suspended",
              liveUrl: null,
              idleExpiresAt: null,
              window: undefined,
            },
            viewer: null,
          },
    );
  });
  context.mocks.api(browserContract.open, ({ query, body, respond }) => {
    expect(query).toStrictEqual({ viewer: "native" });
    if (opensDenied) {
      return respond(503, {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Browser opening is temporarily unavailable",
        },
      });
    }
    active = true;
    operationId = body.operationId;
    onOpen?.(body.operationId);
    return respond(200, { browser: session, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  return {
    browser,
    operationId() {
      return operationId;
    },
    holdReads() {
      const barrier = context.mocks.deferred<void>();
      readBarrier = barrier.promise;
      return () => {
        readBarrier = null;
        barrier.resolve();
      };
    },
    denyReads(value = true) {
      readsDenied = value;
    },
    denyOpens() {
      opensDenied = true;
    },
    replaceViewer() {
      const replacementEndpoint = `${endpoint}/replacement`;
      viewer = { ...viewer, cdpUrl: replacementEndpoint };
      return mockBrowserCdp(context, replacementEndpoint, nativeOptions);
    },
    advance(ms: number) {
      act(() => {
        elapsed += ms;
      });
    },
    start() {
      return setupPage({
        context,
        path: `/browsers/${threadId}`,
        ...(access
          ? { cachedChatThreadEvents: access.cachedChatThreadEvents }
          : {}),
      });
    },
  };
}

async function inputWorks(browser: ReturnType<typeof mockBrowserCdp>) {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toBeVisible();
  });
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  const text = `after acquisition ${browser.input.length + 1}`;
  fireEvent.input(input, {
    target: { value: text },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)?.params).toStrictEqual({
      text,
    });
  });
}

function clickStartBrowser() {
  const start = queryAllByRoleFast("button").find((b) => {
    return b.textContent?.trim() === "Start browser";
  });
  expect(start).toBeDefined();
  if (!start) {
    throw new Error("Expected explicit Start");
  }
  click(start);
}

test("An active shared mount uses the acquired connection while other entry points are unavailable", async () => {
  const f = fixture("active");
  f.denyOpens();
  await f.start();
  await inputWorks(f.browser);
  expect(screen.getByLabelText("Address")).toHaveValue("https://owned.example");
});

test("Explicit Start's returned connection enables input while further acquisition is stalled", async () => {
  const f = fixture("suspended");
  await f.start();
  const release = f.holdReads();
  clickStartBrowser();
  await inputWorks(f.browser);
  expect(screen.getByLabelText("Address")).toHaveValue("https://owned.example");
  release();
});

test.each([1, 2])(
  "Start's %s lifecycle notifications preserve its returned usable connection",
  async (notifications) => {
    const f = fixture("suspended", undefined, (operationId) => {
      for (let index = 0; index < notifications; index++) {
        context.mocks.ably.trigger("browserSessionChanged", {
          threadId,
          ...(operationId ? { operationId } : {}),
        });
      }
    });
    await f.start();
    const release = f.holdReads();
    clickStartBrowser();
    await inputWorks(f.browser);
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://owned.example",
    );
    release();
  },
);

test("A late open echo is ignored while another operation still refreshes the viewer", async () => {
  const f = fixture("suspended");
  await f.start();
  clickStartBrowser();
  await inputWorks(f.browser);
  const release = f.holdReads();
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", {
      threadId,
      operationId: f.operationId(),
    });
  });
  await inputWorks(f.browser);
  release();
  f.denyReads();
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", {
      threadId,
      operationId: "55555555-5555-4555-8555-555555555555",
    });
  });
  await screen.findByText("Cloud browser is not enabled for this chat");
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();
});

test("An uncorrelated notification during Start still invalidates the acquisition", async () => {
  const f = fixture("suspended", undefined, () => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await f.start();
  f.denyReads();
  clickStartBrowser();
  await screen.findByText("Cloud browser is not enabled for this chat");
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();
});

test("A notification that invalidates Start also retires that operation's echo ID", async () => {
  const f = fixture("suspended", undefined, () => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await f.start();
  f.denyReads();
  clickStartBrowser();
  await screen.findByText("Cloud browser is not enabled for this chat");
  f.denyReads(false);
  f.denyOpens();
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", {
      threadId,
      operationId: f.operationId(),
    });
  });
  await inputWorks(f.browser);
  expect(screen.getByLabelText("Address")).toHaveValue("https://owned.example");
});

test("Reconnect uses a fresh connection while explicit opening is unavailable", async () => {
  const f = fixture("active");
  f.denyOpens();
  await f.start();
  await inputWorks(f.browser);
  act(() => {
    return f.browser.disconnect({ code: 1006, wasClean: false });
  });
  await screen.findByText("Reconnecting…");
  const replacement = f.replaceViewer();
  f.advance(1000);
  await inputWorks(replacement);
  expect(screen.getByLabelText("Address")).toHaveValue("https://owned.example");
});

test("A renewed grant cannot reuse the previous grant's explicit-open result", async () => {
  const access = authorization();
  const f = fixture("suspended", access);
  await f.start();
  clickStartBrowser();
  await inputWorks(f.browser);
  f.denyOpens();
  act(() => {
    return access.change(false);
  });
  await screen.findByText("Cloud browser is not enabled for this chat");
  const replacement = f.replaceViewer();
  act(() => {
    return access.change(true);
  });
  await inputWorks(replacement);
  expect(screen.getByLabelText("Address")).toHaveValue("https://owned.example");
});
