import { randomUUID } from "node:crypto";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { HttpResponse, http } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { controlBrowserDeadline } from "./helpers/browser-deadline";
import {
  createBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-fixture";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";

const context = testContext();
const runsApi = createRunsApi(context);
const browserFixtures = createBrowserFixtures(context);
const sessionHeaders = Object.freeze({
  authorization: "Bearer clerk-session",
});

function browserClient() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function requireActiveWindow(
  session: Awaited<ReturnType<typeof browserFixtures.view>>,
) {
  if (session.status !== "active") {
    throw new Error("Expected an active Browser session");
  }
  return session.window;
}

function findWindowTarget(
  provider: ReturnType<typeof browserFixtures.profileProvider>,
  windowId: number,
) {
  const target = [...provider.native.targets.values()].find((entry) => {
    return entry.windowId === windowId;
  });
  if (!target) {
    throw new Error(`Expected target in window ${String(windowId)}`);
  }
  return target;
}

function urlsInWindow(
  provider: ReturnType<typeof browserFixtures.profileProvider>,
  windowId: number,
) {
  return [...provider.native.targets.values()]
    .filter((entry) => {
      return entry.windowId === windowId;
    })
    .map((entry) => {
      return entry.url;
    });
}

function versionUrlFor(cdpUrl: string): string {
  const versionUrl = new URL(cdpUrl);
  versionUrl.protocol = "https:";
  versionUrl.pathname += "/json/version";
  return versionUrl.href;
}

function browserSessionChangedEvents() {
  return context.mocks.ably.publish.mock.calls
    .filter((call) => {
      return call[0] === "browserSessionChanged";
    })
    .map((call) => {
      return call[1];
    });
}

describe("Browser reuse, expiry, and viewer acquisition", () => {
  beforeAll(async () => {
    await settleIncludingAbort(async () => {
      const warmupUser = createBddApi(context).user();
      await runsApi.grantProEntitlement(warmupUser);
      await runsApi.configureRunnerGroup();
    });
  });

  it(
    "browser-reuse-004 opens a new run window without probing an unrelated live sibling",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const chatB = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);

      provider.native.nativeWindowErrors.set(
        windowA.primaryWindowId,
        "Window A health check failed",
      );

      const commandsBefore = provider.native.commands.length;
      const openedB = await browserFixtures.open(chatB);
      const commandsDuringB = provider.native.commands.slice(commandsBefore);
      const windowB = requireActiveWindow(openedB);
      const readA = await browserFixtures.view(chatA);

      expect(windowB.instanceId).toBe(windowA.instanceId);
      expect(windowB.primaryWindowId).not.toBe(windowA.primaryWindowId);
      expect(
        commandsDuringB.some((command) => {
          return command.method === "Browser.getWindowBounds";
        }),
      ).toBeFalsy();
      expect(requireActiveWindow(readA)).toStrictEqual(windowA);
      expect(provider.sessionRequests).toHaveLength(1);
    },
  );

  it(
    "browser-reclaim-011 reuses a renewed window instead of reclaiming it at its earlier deadline",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);
      findWindowTarget(provider, windowA.primaryWindowId).url =
        "https://a.example.test/working";

      mockNow(START + 9 * MINUTE);
      await browserFixtures.renew(chatA);

      mockNow(START + 11 * MINUTE);
      const reusedA = await browserFixtures.open(chatA);

      expect(requireActiveWindow(reusedA)).toStrictEqual(windowA);
      expect(urlsInWindow(provider, windowA.primaryWindowId)).toStrictEqual([
        "https://a.example.test/working",
      ]);
      expect(provider.sessionRequests).toHaveLength(1);
    },
  );

  it(
    "browser-reuse-005 opens a new chat window without probing an unrelated live sibling",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);

      const createdB = await accept(
        setupApp({ context, routes: chatThreadCreateRoutes })(
          chatThreadsContract,
        ).create({ headers: sessionHeaders, body: {} }),
        [201],
      );
      const threadB = createdB.body.id;

      provider.native.nativeWindowErrors.set(
        windowA.primaryWindowId,
        "Window A health check failed",
      );

      const commandsBefore = provider.native.commands.length;
      const openedB = await accept(
        browserClient().open({
          headers: sessionHeaders,
          params: { threadId: threadB },
          body: {},
        }),
        [200],
      );
      const commandsDuringB = provider.native.commands.slice(commandsBefore);
      const windowB = requireActiveWindow(openedB.body.browser);
      const readA = await browserFixtures.view(chatA);

      expect(windowB.instanceId).toBe(windowA.instanceId);
      expect(windowB.primaryWindowId).not.toBe(windowA.primaryWindowId);
      expect(
        commandsDuringB.some((command) => {
          return command.method === "Browser.getWindowBounds";
        }),
      ).toBeFalsy();
      expect(requireActiveWindow(readA)).toStrictEqual(windowA);
      expect(provider.sessionRequests).toHaveLength(1);
    },
  );

  it(
    "browser-reuse-006 recovers a confirmed stopped provider without reusing its old instance",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);

      for (const sessionId of provider.sessionIds) {
        provider.sessionIds.delete(sessionId);
        provider.stoppedSessionIds.add(sessionId);
      }
      provider.native.targets.clear();

      const recovered = await browserFixtures.open(chatA);
      const recoveredWindow = requireActiveWindow(recovered);
      const readA = await browserFixtures.view(chatA);

      expect(recoveredWindow.instanceId).not.toBe(windowA.instanceId);
      expect(provider.sessionRequests).toHaveLength(2);
      expect(requireActiveWindow(readA)).toStrictEqual(recoveredWindow);
    },
  );

  it(
    "browser-reuse-007 returns a provider failure without retrying or reclaiming the live binding",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);
      const originalExpiry = openedA.idleExpiresAt;

      let failRead = true;
      let providerReads = 0;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, () => {
          if (failRead) {
            providerReads += 1;
            return HttpResponse.json(
              { detail: "Provider session lookup unavailable" },
              { status: 503 },
            );
          }
          return undefined;
        }),
        ...provider.handlers,
      );

      mockNow(START + MINUTE);
      const failed = await accept(
        browserClient().use({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
          },
          body: {},
        }),
        [502],
      );
      expect(failed.status).toBe(502);
      expect(providerReads).toBe(1);
      expect(provider.sessionRequests).toHaveLength(1);
      expect(provider.stoppedSessionIds.size).toBe(0);

      failRead = false;
      const readA = await browserFixtures.view(chatA);
      expect(requireActiveWindow(readA)).toStrictEqual(windowA);
      expect(readA.idleExpiresAt).toBe(originalExpiry);
    },
  );

  it(
    "browser-reuse-008 returns a native failure without retrying or reclaiming the live binding",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);
      const originalExpiry = openedA.idleExpiresAt;

      let watching = false;
      let providerReads = 0;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, () => {
          if (watching) {
            providerReads += 1;
          }
          return undefined;
        }),
        ...provider.handlers,
      );

      mockNow(START + MINUTE);
      provider.native.windowBoundsError = {
        code: -32_000,
        message: "Native bounds error",
      };
      watching = true;
      const failed = await accept(
        browserClient().use({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
          },
          body: {},
        }),
        [502],
      );
      watching = false;

      expect(failed.status).toBe(502);
      expect(providerReads).toBe(1);
      expect(provider.sessionRequests).toHaveLength(1);
      expect(provider.stoppedSessionIds.size).toBe(0);

      provider.native.windowBoundsError = undefined;
      const readA = await browserFixtures.view(chatA);
      expect(requireActiveWindow(readA)).toStrictEqual(windowA);
      expect(readA.idleExpiresAt).toBe(originalExpiry);
    },
  );

  it(
    "browser-reuse-010 retains the native binding when the provider closes before-reply without replaying health",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);

      let activeSocket: Pick<WebSocket, "close"> | undefined;
      provider.native.onSocketConnection = (socket) => {
        activeSocket = socket;
      };
      provider.native.windowReply = "withhold";
      provider.native.onWithheldReply = () => {
        activeSocket?.close(1011, "private-close-reason-secret");
      };

      const commandsBefore = provider.native.commands.length;
      const failed = await accept(
        browserClient().use({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
          },
          body: {},
        }),
        [502],
      );
      const commandsDuringUse = provider.native.commands.slice(commandsBefore);

      expect(failed.status).toBe(502);
      expect(JSON.stringify(failed.body)).not.toContain(
        "private-close-reason-secret",
      );
      expect(commandsDuringUse).toHaveLength(1);
      expect(commandsDuringUse[0]).toMatchObject({
        method: "Browser.getWindowBounds",
      });
      expect(provider.sessionRequests).toHaveLength(1);
      expect(provider.stoppedSessionIds.size).toBe(0);

      provider.native.windowReply = "reply";
      provider.native.onWithheldReply = undefined;
      provider.native.onSocketConnection = undefined;

      const readA = await browserFixtures.view(chatA);
      const reusedA = await browserFixtures.open(chatA);
      expect(requireActiveWindow(readA)).toStrictEqual(windowA);
      expect(requireActiveWindow(reusedA)).toStrictEqual(windowA);
    },
  );

  it(
    'browser-expiry-006 preserves a healthy logical window on CDP failure: {"code":-32000,"message":"Native health unavailable"}',
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);
      const originalExpiry = openedA.idleExpiresAt;
      expect(windowA.primaryWindowId).toBe(0);

      mockNow(START + 9 * MINUTE);
      provider.native.windowBoundsError = {
        code: -32_000,
        message: "Native health unavailable",
      };

      const failedUse = await accept(
        browserClient().use({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
          },
          body: {},
        }),
        [502],
      );
      expect(failedUse.status).toBe(502);

      const readA = await browserFixtures.view(chatA);
      expect(requireActiveWindow(readA)).toStrictEqual(windowA);
      expect(readA.idleExpiresAt).toBe(originalExpiry);
      expect(provider.stoppedSessionIds.size).toBe(0);

      provider.native.windowBoundsError = undefined;
      const renewedA = await browserFixtures.renew(chatA);
      expect(requireActiveWindow(renewedA)).toStrictEqual(windowA);
      expect(provider.sessionRequests).toHaveLength(1);
    },
  );

  it(
    "browser-expiry-008 preserves the native health timeout response and recovers the same window",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const openedA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(openedA);

      const expireDeadline = controlBrowserDeadline(context);
      provider.native.windowReply = "withhold";
      provider.native.onWithheldReply = () => {
        expireDeadline();
      };

      const timedOut = await accept(
        browserClient().leaseByThread({
          headers: sessionHeaders,
          params: { threadId: chatA.threadId },
          body: {},
        }),
        [503],
      );
      expect(timedOut.body.error.code).toBe("BROWSER_USE_TIMEOUT");

      provider.native.windowReply = "reply";
      provider.native.onWithheldReply = undefined;

      const renewedA = await browserFixtures.renew(chatA);
      expect(requireActiveWindow(renewedA)).toStrictEqual(windowA);
      expect(provider.sessionRequests).toHaveLength(1);
      expect(provider.stoppedSessionIds.size).toBe(0);
    },
  );

  it(
    "browser-viewer-acquisition-002 open acquires presentation and viewer with one provider observation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      let watching = false;
      let providerSessionReads = 0;
      let discoveryCalls = 0;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, () => {
          if (watching) {
            providerSessionReads += 1;
          }
          return undefined;
        }),
        http.get(versionUrlFor(provider.native.url), () => {
          if (watching) {
            discoveryCalls += 1;
          }
          return undefined;
        }),
        ...provider.handlers,
      );

      const chat = await start();
      const opened = await browserFixtures.open(chat);
      const windowA = requireActiveWindow(opened);
      await flushWaitUntilForTest();
      context.mocks.ably.publish.mockClear();

      const operationId = randomUUID();
      watching = true;
      const response = await accept(
        browserClient().open({
          headers: sessionHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
          body: { operationId },
        }),
        [200],
      );
      watching = false;
      await flushWaitUntilForTest();

      const laterRead = await browserFixtures.view(chat);

      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(requireActiveWindow(response.body.browser)).toStrictEqual(windowA);
      expect(response.body.viewer).toMatchObject({
        browser: response.body.browser,
        cdpUrl: provider.native.url,
      });
      expect(providerSessionReads).toBe(1);
      expect(discoveryCalls).toBe(1);
      expect(provider.sessionRequests).toHaveLength(1);
      expect(browserSessionChangedEvents()).toStrictEqual([
        { threadId: chat.threadId, operationId },
      ]);
      expect(requireActiveWindow(laterRead)).toStrictEqual(windowA);
    },
  );

  it(
    "browser-viewer-acquisition-003 read acquisition does not create a missing Browser and preserves stopped presentation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chat = await start();

      const missingRead = await accept(
        browserClient().get({
          headers: sessionHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
        }),
        [404],
      );
      expect(missingRead.status).toBe(404);
      expect(provider.sessionRequests).toStrictEqual([]);

      await browserFixtures.open(chat);
      for (const sessionId of provider.sessionIds) {
        provider.sessionIds.delete(sessionId);
        provider.stoppedSessionIds.add(sessionId);
      }

      const stoppedRead = await accept(
        browserClient().get({
          headers: sessionHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
        }),
        [200],
      );
      expect(stoppedRead.body.browser.status).toBe("suspended");
      expect(stoppedRead.body.browser.liveUrl).toBeNull();
      expect(stoppedRead.body.browser.idleExpiresAt).toBeNull();
      expect(stoppedRead.body.viewer).toBeNull();
      expect(provider.sessionRequests).toHaveLength(1);
    },
  );

  it(
    "browser-viewer-acquisition-005 native open correlates its expired-window retirement and final publication",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start } = await browserFixtures.fixture();
      const chat = await start();
      const opened = await browserFixtures.open(chat);
      const windowA = requireActiveWindow(opened);
      await flushWaitUntilForTest();
      context.mocks.ably.publish.mockClear();

      mockNow(START + 11 * MINUTE);
      const operationId = randomUUID();
      const reopened = await accept(
        browserClient().open({
          headers: sessionHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
          body: { operationId },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const viewerWindow = reopened.body.viewer?.browser.window;
      if (!viewerWindow) {
        throw new Error("Expected viewer window in native open response");
      }
      expect(viewerWindow.instanceId).not.toBe(windowA.instanceId);
      expect(browserSessionChangedEvents()).toStrictEqual([
        { threadId: chat.threadId, operationId },
        { threadId: chat.threadId, operationId },
      ]);
    },
  );

  it(
    "browser-viewer-acquisition-006 only signed-in shared callers can opt into viewer credentials",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start } = await browserFixtures.fixture();
      const chat = await start();
      const opened = await browserFixtures.open(chat);
      const windowA = requireActiveWindow(opened);
      const runHeaders = {
        authorization: `Bearer ${okouTokenFromExecution(chat.execution)}`,
      };

      const runViewerGet = await accept(
        browserClient().get({
          headers: runHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
        }),
        [403],
      );
      expect(runViewerGet.body.error.code).toBe(
        "BROWSER_VIEWER_SESSION_REQUIRED",
      );

      const runViewerOpen = await accept(
        browserClient().open({
          headers: runHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
          body: {},
        }),
        [403],
      );
      expect(runViewerOpen.body.error.code).toBe(
        "BROWSER_VIEWER_SESSION_REQUIRED",
      );

      const runOrdinaryGet = await accept(
        browserClient().get({
          headers: runHeaders,
          params: { threadId: chat.threadId },
        }),
        [200],
      );
      expect(runOrdinaryGet.body.browser.status).toBe("active");

      const ownerViewerGet = await accept(
        browserClient().get({
          headers: sessionHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
        }),
        [200],
      );
      expect(ownerViewerGet.body.viewer?.browser.window).toStrictEqual(windowA);
    },
  );

  it(
    "browser-viewer-connection-002 reuses provider WSS without requiring HTTPS discovery",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chat = await start();
      await browserFixtures.open(chat);

      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
          return HttpResponse.json({
            id: String(params.id),
            status: "active",
            startedAt: new Date(START).toISOString(),
            timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
            finishedAt: null,
            liveUrl: null,
            cdpUrl: provider.native.url,
            extensions: [TEST_BROWSER_EXTENSION],
          });
        }),
        http.get(versionUrlFor(provider.native.url), () => {
          return HttpResponse.json({
            webSocketDebuggerUrl: "https://invalid.example",
          });
        }),
        ...provider.handlers,
      );

      const viewerResponse = await accept(
        browserClient().get({
          headers: sessionHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
        }),
        [200],
      );
      const ordinaryResponse = await accept(
        browserClient().get({
          headers: sessionHeaders,
          params: { threadId: chat.threadId },
        }),
        [200],
      );

      expect(viewerResponse.body.browser.status).toBe("active");
      expect(viewerResponse.body.browser.liveUrl).toBeNull();
      expect(viewerResponse.body.viewer).toStrictEqual({
        browser: viewerResponse.body.browser,
        cdpUrl: provider.native.url,
        extension: TEST_BROWSER_EXTENSION,
      });
      expect(ordinaryResponse.body.browser).toStrictEqual(
        viewerResponse.body.browser,
      );
    },
  );

  it(
    "browser-viewer-connection-005 rejects an untrusted discovery endpoint without returning provider payloads",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chat = await start();
      await browserFixtures.open(chat);

      server.use(
        http.get(versionUrlFor(provider.native.url), () => {
          return HttpResponse.json({
            webSocketDebuggerUrl: "wss://untrusted.example/private-token",
          });
        }),
        ...provider.handlers,
      );

      const response = await accept(
        browserClient().get({
          headers: sessionHeaders,
          params: { threadId: chat.threadId },
          query: { viewer: "native" },
        }),
        [502],
      );

      expect(response.body.error.code).toBe("BROWSER_USE_DISCOVERY_ERROR");
      expect(response.body.error.message).toBe(
        "Managed browser provider could not connect the viewer",
      );
      expect(JSON.stringify(response.body)).not.toContain("private-token");
    },
  );
});
