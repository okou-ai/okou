import { randomUUID } from "node:crypto";

import { testBrowserReconcileContract } from "@okouai/api-contracts/contracts/test-browser-reconcile";
import {
  browserAuthorizationRequestsContract,
  browserContract,
} from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadComputerUseHostContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { HttpResponse, http } from "msw";
import { aroundEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { deleteChatThreadRootFixture } from "../../../test-fixtures/chat-thread-deletion";
import { deleteAgentRunRootFixture } from "../../../test-fixtures/run-deletion";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import {
  setBrowserTabSnapshotAsPreviousApi,
  setComputerUseHostAsPreviousApi,
} from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { testBrowserReconcileRoutes } from "../test-browser-reconcile";
import { browserRoutes } from "../browser";
import { browserAuthorizationRoutes } from "../browser-authorization";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadComputerUseHostRoutes } from "../chat-threads-computer-use-host";

const TEST_APP_ROUTES = Object.freeze([
  ...browserAuthorizationRoutes,
  ...browserRoutes,
  ...chatThreadRoutes,
]);

const context = testContext();
const computerUse = createComputerUseBddApi(context);
const BROWSER_USE_API_URL = "https://api.browser-use.com/api/v3";
const STARTED_AT_MS = Date.parse("2026-07-24T10:00:00.000Z");
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command) ||
    typeof command.input !== "object" ||
    command.input === null
  ) {
    return {};
  }
  return command.input as Record<string, unknown>;
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function isoAt(offsetMs: number): string {
  return new Date(STARTED_AT_MS + offsetMs).toISOString();
}

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function authorizationClient(baseUrl = "http://api.test") {
  return setupApp({
    baseUrl,
    context,
    routes: browserAuthorizationRoutes,
  })(browserAuthorizationRequestsContract);
}

function chatThreadsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

function chatThreadComputerUseHostClient() {
  return setupApp({ context, routes: chatThreadComputerUseHostRoutes })(
    chatThreadComputerUseHostContract,
  );
}

function browserReconcileClient() {
  return setupApp({ context, routes: testBrowserReconcileRoutes })(
    testBrowserReconcileContract,
  );
}

async function requestBrowserUse(
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  return await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request("/api/browsers/use", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
}

function providerBrowser(
  id: string,
  args: {
    readonly status?: "active" | "stopped";
  } = {},
) {
  const status = args.status ?? "active";
  return {
    id,
    status,
    liveUrl:
      status === "active"
        ? "https://live.browser-use.com/?wss=provider-live-token"
        : null,
    cdpUrl: status === "active" ? `https://${id}.cdp.browser-use.com/` : null,
    // The API buys the provider's longest lifetime and reclaims idle browsers
    // itself, so the provider deadline stays far away in these tests.
    timeoutAt: isoAt(240 * MINUTE_MS),
    startedAt: isoAt(0),
    finishedAt: status === "stopped" ? isoAt(10 * MINUTE_MS) : null,
    agentSessionId: null,
    recordingUrl: null,
  };
}

function providerProfile(id: string, name: string) {
  return {
    id,
    userId: null,
    name,
    lastUsedAt: null,
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
    cookieDomains: null,
  };
}

function browserUseCdpWebSocketUrl(providerSessionId: string): string {
  return `wss://${providerSessionId}.cdp.browser-use.com/devtools/browser/test`;
}

function acceptBrowserUseCdpSessions(
  providerSessionIds: readonly string[],
): void {
  for (const providerSessionId of providerSessionIds) {
    const webSocketUrl = browserUseCdpWebSocketUrl(providerSessionId);
    server.use(
      http.get(
        `https://${providerSessionId}.cdp.browser-use.com/json/version`,
        () => {
          return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
        },
      ),
      browserUseCdpHandler(webSocketUrl),
    );
  }
}

function browserHeadersForRun(
  runs: ReturnType<typeof createRunsApi>,
  actor: ApiTestUser,
  runId: string,
): { readonly authorization: string } {
  const browserToken = runs.okouTokenForRunWithCapabilities(actor, runId, [
    "browser:read",
    "browser:write",
  ]);
  return { authorization: `Bearer ${browserToken}` };
}

async function claimChatRun(
  runs: ReturnType<typeof createRunsApi>,
  actor: ApiTestUser,
  runId: string,
) {
  await flushWaitUntilForTest();
  const claim = await runs.claimRunnerJob(runId);
  const okouToken = claim.platformEnvironment.OKOU_TOKEN;
  if (!okouToken) {
    throw new Error("Expected the runner claim to include OKOU_TOKEN");
  }
  return {
    browserHeaders: browserHeadersForRun(runs, actor, runId),
    sandboxHeaders: {
      authorization: `Bearer ${claim.sandboxToken}`,
    },
  };
}

async function setupBrowserScenario() {
  mockNow(STARTED_AT_MS);
  mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
  mockEnv("APP_URL", "https://app.okou.ai");
  server.use(
    http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const bdd = createBddApi(context);
  const routeMocks = createRouteMocks(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const callbacks = createChatCallbacksApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Managed browser tests require an organization");
  }
  const orgActor = { ...actor, orgId: actor.orgId };
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  callbacks.failIfChatCallbackRouteIsFetched();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.heartbeatRunner(runnerGroup);
  await runs.grantProEntitlement(orgActor);
  await runs.ensureOrgModelProvider(orgActor);
  const agent = await bdd.createAgent(orgActor, {
    displayName: "Managed Browser Test",
    visibility: "private",
  });

  return {
    routeMocks,
    runs,
    chat,
    webhooks,
    actor: orgActor,
    runnerGroup,
    agent,
  };
}

async function createClaimedChatRun(
  chat: ReturnType<typeof createChatFilesBddApi>,
  runs: ReturnType<typeof createRunsApi>,
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
) {
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId,
      prompt,
      cloudBrowserEnabled: true,
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected a chat run");
  }
  return {
    sent,
    runId: sent.body.runId,
    threadId: sent.body.threadId,
    claim: await claimChatRun(runs, actor, sent.body.runId),
  };
}

async function reconcileBrowsers(
  chatThreadId: string,
  ...additionalChatThreadIds: string[]
) {
  return await accept(
    browserReconcileClient().reconcile({
      body: {
        chat_thread_ids: [chatThreadId, ...additionalChatThreadIds],
      },
    }),
    [200],
  );
}

describe("okou browser route", () => {
  it("requires a chat thread when starting a managed browser", async () => {
    const { runs, actor } = await setupBrowserScenario();

    const rejected = await requestBrowserUse(
      browserHeadersForRun(runs, actor, randomUUID()),
    );
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toStrictEqual({
      error: {
        code: "BROWSER_CHAT_THREAD_REQUIRED",
        message: "Managed browsers can only be started from an Okou chat run",
      },
    });
  });

  it("keeps managed browser access off for a default chat thread", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Try to open a managed browser without enabling it",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const claim = await runs.claimRunnerJob(sent.body.runId);
    expect(claim.appendSystemPrompt ?? "").toContain(
      "Okou Browser is currently off for this chat thread",
    );
    const browserToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      ["browser:read", "browser:write"],
    );

    const rejected = await requestBrowserUse({
      authorization: `Bearer ${browserToken}`,
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: "Cloud browser is not enabled for this chat thread",
      },
    });
  });

  it("advertises managed browser access for an enabled chat thread", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Open a managed browser",
        cloudBrowserEnabled: true,
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }

    const claim = await runs.claimRunnerJob(sent.body.runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(appendSystemPrompt).toContain(
      "Okou Browser and Okou Computer Use are separate surfaces. `okou browser use` creates, reuses, or resumes a remote browser",
    );
    expect(appendSystemPrompt).toContain(
      "Okou Browser lifetime: `okou browser use` and `okou browser lease` each extend the session's idle lease by a fixed 10 minutes",
    );
    expect(appendSystemPrompt).not.toContain(
      "Okou Browser is currently off for this chat thread",
    );
  });

  it("normalizes a previous API host-only write during cloud browser rollout", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Open a managed browser before selecting this computer",
        cloudBrowserEnabled: true,
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const host = await computerUse.startComputerUseHost(actor);

    // The preceding API version knows only computer_use_host_id, so this
    // intentionally omits cloudBrowserEnabled from its update shape.
    await setComputerUseHostAsPreviousApi(context, {
      threadId: sent.body.threadId,
      computerUseHostId: host.hostId,
    });

    const browserToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      ["browser:read", "browser:write"],
    );
    const rejected = await requestBrowserUse({
      authorization: `Bearer ${browserToken}`,
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: "Cloud browser is not enabled for this chat thread",
      },
    });
  });

  it("uses the configured app URL for browser authorization from run tokens", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Ask the user to enable a cloud browser",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const sandboxRunToken = runs.sandboxTokenForRun(actor, sent.body.runId);
    const sandboxCreated = await accept(
      authorizationClient().create({
        headers: { authorization: `Bearer ${sandboxRunToken}` },
        body: {},
      }),
      [200],
    );
    expect(new URL(sandboxCreated.body.authorizationUrl).origin).toBe(
      "https://app.okou.ai",
    );
    const okouRunToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      [],
    );
    const createdOnOkouApi = await accept(
      authorizationClient("https://api.okou.ai").create({
        headers: { authorization: `Bearer ${okouRunToken}` },
        body: {},
      }),
      [200],
    );
    expect(new URL(createdOnOkouApi.body.authorizationUrl).origin).toBe(
      "https://app.okou.ai",
    );
    const requestToken = decodeURIComponent(
      new URL(createdOnOkouApi.body.authorizationUrl).pathname
        .split("/")
        .at(-1) ?? "",
    );
    expect(requestToken).toMatch(/^vm0_browser_authorization_request_/u);

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const pending = await accept(
      authorizationClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken },
      }),
      [200],
    );
    expect(pending.body).toMatchObject({
      completedAt: null,
      cloudBrowserEnabled: false,
    });

    const applied = await accept(
      authorizationClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken },
        body: {},
      }),
      [200],
    );
    expect(applied.body).toStrictEqual({
      ok: true,
      cloudBrowserEnabled: true,
    });

    const events = await accept(
      chatThreadsClient().events({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        kind: "computer_use_host_updated",
        chatThreadId: sent.body.threadId,
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      }),
    );
  });

  it("isolates profiles across concurrent thread browser sessions", async () => {
    const { routeMocks, runs, chat, webhooks, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );
    const firstBrowserHeaders = browserHeadersForRun(runs, actor, first.runId);
    const other = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Use a separate profile from another thread",
    );

    const profileIds = [randomUUID(), randomUUID()] as const;
    const providerIds = [randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    const providerCreateBodies: unknown[] = [];
    const deletedProfiles: string[] = [];
    const stoppedProviderIds: string[] = [];
    let profileCreates = 0;
    let providerCreates = 0;
    // The reconcile route is global, so count only this test's own instances.
    const providerStops = () => {
      return stoppedProviderIds.filter((stopped) => {
        return (providerIds as readonly string[]).includes(stopped);
      }).length;
    };
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        expect(request.headers.get("x-browser-use-api-key")).toBe(
          "test-browser-use-key",
        );
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        expect(body.name).toMatch(/^okou-browser-profile-[0-9a-f-]{36}$/u);
        const profileId = profileIds[profileCreates];
        profileCreates += 1;
        if (!profileId) {
          return HttpResponse.json(
            { error: "unexpected profile create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerProfile(profileId, body.name), {
          status: 201,
        });
      }),
      http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, ({ params }) => {
        const profileId = String(params.id);
        deletedProfiles.push(profileId);
        if (
          profileId === profileIds[0] &&
          deletedProfiles.filter((deleted) => {
            return deleted === profileId;
          }).length === 1
        ) {
          return HttpResponse.json(
            { detail: "temporary Browser Use outage" },
            { status: 503 },
          );
        }
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, async ({ request }) => {
        providerCreateBodies.push(await request.json());
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(
        `${BROWSER_USE_API_URL}/browsers/:id`,
        async ({ params, request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            action: "stop",
          });
          stoppedProviderIds.push(String(params.id));
          return HttpResponse.json(
            providerBrowser(String(params.id), { status: "stopped" }),
          );
        },
      ),
    );

    const firstCreateRequest = client().create({
      headers: firstBrowserHeaders,
      body: {
        name: "booking",
        proxyCountryCode: null,
      },
    });
    const otherCreateRequest = client().create({
      headers: other.claim.browserHeaders,
      body: {
        name: "research",
        proxyCountryCode: null,
      },
    });
    const [created, createdInOtherThread] = await Promise.all([
      accept(firstCreateRequest, [201]),
      accept(otherCreateRequest, [201]),
    ]);
    expect(created.body.browser).toMatchObject({
      name: "booking",
      status: "active",
      // The API always requests the provider's longest lifetime and manages
      // reclamation through the idle lease instead.
      timeoutMinutes: 240,
      idleExpiresAt: isoAt(10 * MINUTE_MS),
      viewerUrl: `https://app.okou.ai/browsers/${created.body.browser.threadId}`,
      screen: {
        width: 1440,
        height: 900,
        resizable: true,
      },
    });
    expect(created.body.cdpUrl).toMatch(
      /^https:\/\/[0-9a-f-]{36}\.cdp\.browser-use\.com\/$/u,
    );
    expect(createdInOtherThread.body.browser).toMatchObject({
      name: "research",
      status: "active",
      viewerUrl: `https://app.okou.ai/browsers/${createdInOtherThread.body.browser.threadId}`,
      screen: {
        width: 1440,
        height: 900,
        resizable: true,
      },
    });
    expect(createdInOtherThread.body.browser.threadId).not.toBe(
      created.body.browser.threadId,
    );
    expect(profileCreates).toBe(2);
    expect(providerCreates).toBe(2);
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Browser.setContentsSize";
        }),
    ).toStrictEqual([
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 900 },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 900 },
      },
    ]);

    const crossThreadResize = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(
      `/api/chat-threads/${createdInOtherThread.body.browser.threadId}/browser/resize`,
      {
        method: "POST",
        headers: {
          ...firstBrowserHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ aspectRatio: 0.75 }),
      },
    );
    expect(crossThreadResize.status).toBe(404);
    await expect(crossThreadResize.json()).resolves.toMatchObject({
      error: { code: "BROWSER_NOT_FOUND" },
    });

    expect(
      providerCreateBodies.map((body) => {
        return z
          .strictObject({
            profileId: z.uuid(),
            proxyCountryCode: z.null(),
            timeout: z.literal(240),
            browserScreenWidth: z.literal(1440),
            browserScreenHeight: z.literal(900),
            allowResizing: z.literal(true),
            enableRecording: z.literal(false),
          })
          .parse(body).profileId;
      }),
    ).toStrictEqual(expect.arrayContaining([...profileIds]));
    expect(deletedProfiles).toStrictEqual([]);

    const createdProviderId = new URL(created.body.cdpUrl).hostname.split(
      ".",
    )[0];
    if (!createdProviderId) {
      throw new Error("Expected a Browser Use provider ID");
    }
    const cdpWebSocketUrl = browserUseCdpWebSocketUrl(createdProviderId);
    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const resized = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: created.body.browser.threadId },
        body: { aspectRatio: 0.75 },
      }),
      [200],
    );
    expect(resized.body.browser).toMatchObject({
      threadId: created.body.browser.threadId,
      screen: {
        width: 1440,
        height: 1920,
        resizable: true,
      },
    });
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledTimes(1);
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledWith(
      cdpWebSocketUrl,
    );
    expect(
      context.mocks.browserUseCdp.command.mock.calls.map(([command]) => {
        return command;
      }),
    ).toStrictEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      {
        id: 2,
        method: "Browser.getWindowForTarget",
        params: { targetId: "page-target" },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 1920 },
      },
    ]);

    const restoredForAnotherViewer = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { threadId: created.body.browser.threadId },
      }),
      [200],
    );
    expect(restoredForAnotherViewer.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 1920,
      resizable: true,
    });
    expect(restoredForAnotherViewer.body.browser.viewerUrl).toBe(
      `https://app.okou.ai/browsers/${created.body.browser.threadId}`,
    );

    context.mocks.browserUseCdp.command.mockClear();
    const clampedTall = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: created.body.browser.threadId },
        body: { aspectRatio: 0.1 },
      }),
      [200],
    );
    expect(clampedTall.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 3456,
      resizable: true,
    });
    const clampedWide = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: created.body.browser.threadId },
        body: { aspectRatio: 10 },
      }),
      [200],
    );
    expect(clampedWide.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 320,
      resizable: true,
    });
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Browser.setContentsSize";
        }),
    ).toStrictEqual([
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 3456 },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 320 },
      },
    ]);
    const copiedToAnotherThread = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(`/api/chat-threads/${randomUUID()}/browser`, {
      headers: firstBrowserHeaders,
    });
    expect(copiedToAnotherThread.status).toBe(404);

    const duplicateNew = await accept(
      client().create({
        headers: firstBrowserHeaders,
        body: {
          name: "another",
          proxyCountryCode: null,
        },
      }),
      [201],
    );
    expect(duplicateNew.body.browser).toMatchObject({
      threadId: created.body.browser.threadId,
      name: "booking",
      status: "active",
    });
    expect(providerCreates).toBe(2);
    expect(profileCreates).toBe(2);
    expect(deletedProfiles).toStrictEqual([]);

    // A terminal run leaves its browser live so the user can keep using it, and
    // restarts the idle lease from the end of the run. The clock moves first so
    // the refreshed deadline cannot be confused with the one create wrote.
    mockNow(STARTED_AT_MS + 2 * MINUTE_MS);
    await webhooks.requestAgentComplete(
      {
        runId: first.runId,
        exitCode: 0,
      },
      first.claim.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: other.runId,
        exitCode: 0,
      },
      other.claim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(providerStops()).toBe(0);
    const stillLive = await accept(
      client().get({
        headers: firstBrowserHeaders,
        params: { threadId: created.body.browser.threadId },
      }),
      [200],
    );
    expect(stillLive.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(12 * MINUTE_MS),
    });

    // Thread deletion releases both local slots and requests provider cleanup
    // without waiting for Browser Use.
    mockNow(Date.parse("2026-08-03T06:00:00.000Z"));
    await chat.deleteThread(actor, first.threadId);
    await chat.deleteThread(actor, other.threadId);
    await flushWaitUntilForTest();
    expect(providerStops()).toBe(2);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[0];
      }),
    ).toHaveLength(1);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[1];
      }),
    ).toHaveLength(1);

    // Root deletion preserves browser ownership, so the missing-thread
    // reconciler remains the sole durable provider teardown path.
    await deleteAgentRunRootFixture(first.runId);
    await deleteAgentRunRootFixture(other.runId);
    await reconcileBrowsers(first.threadId, other.threadId);
    expect(providerStops()).toBe(3);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[0];
      }),
    ).toHaveLength(2);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[1];
      }),
    ).toHaveLength(1);
    await reconcileBrowsers(first.threadId, other.threadId);
    expect(providerStops()).toBe(3);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[0];
      }),
    ).toHaveLength(2);
  }, 120_000);

  it("fails browser start when its initial size cannot be applied", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser whose window cannot be resized",
    );
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      return command.method === "Browser.setContentsSize"
        ? new Error("test resize failure")
        : undefined;
    });
    let providerStops = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        providerStops += 1;
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    const failed = await requestBrowserUse(first.claim.browserHeaders);
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "BROWSER_USE_RESIZE_ERROR" },
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    const current = await accept(
      client().current({ headers: first.claim.browserHeaders }),
      [200],
    );
    expect(current.body.browser.status).toBe("error");
    expect(current.body.browser).not.toHaveProperty("screen");

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);
  }, 120_000);

  it("reclaims the earliest idle lease before starting past org concurrency", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );
    const other = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Use the shared profile from another thread",
    );

    // Admission candidates only need a browser-capable run token, so they skip
    // the runner claim that the org's run concurrency limit would throttle.
    async function createCandidate(prompt: string) {
      const sentCandidate = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt,
          cloudBrowserEnabled: true,
        },
        [201],
      );
      if (sentCandidate.status !== 201 || sentCandidate.body.runId === null) {
        throw new Error("Expected a browser admission candidate run");
      }
      return {
        threadId: sentCandidate.body.threadId,
        browserHeaders: {
          authorization: `Bearer ${runs.okouTokenForRunWithCapabilities(
            actor,
            sentCandidate.body.runId,
            ["browser:read", "browser:write"],
          )}`,
        },
      };
    }

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    let providerCreates = 0;
    const providerStopAttempts: string[] = [];
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        const providerId = String(params.id);
        providerStopAttempts.push(providerId);
        if (providerId === providerIds[0]) {
          return HttpResponse.json(
            { detail: "temporary Browser Use outage" },
            { status: 503 },
          );
        }
        return HttpResponse.json(
          providerBrowser(providerId, { status: "stopped" }),
        );
      }),
    );

    await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "booking", proxyCountryCode: null },
      }),
      [201],
    );
    await accept(
      client().create({
        headers: other.claim.browserHeaders,
        body: { name: "research", proxyCountryCode: null },
      }),
      [201],
    );
    expect(providerCreates).toBe(2);

    mockNow(STARTED_AT_MS + MINUTE_MS);
    await accept(
      client().lease({
        headers: other.claim.browserHeaders,
        body: {},
      }),
      [200],
    );
    const candidate = await createCandidate(
      "Start past the managed browser concurrency limit",
    );
    await accept(
      client().create({
        headers: candidate.browserHeaders,
        body: {
          name: "concurrency-replacement",
          proxyCountryCode: null,
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    expect(providerCreates).toBe(3);
    expect(providerStopAttempts).toStrictEqual([providerIds[0]]);

    const reclaimed = await accept(
      client().get({
        headers: first.claim.browserHeaders,
        params: {
          threadId: (
            await accept(
              client().current({
                headers: first.claim.browserHeaders,
              }),
              [200],
            )
          ).body.browser.threadId,
        },
      }),
      [200],
    );
    expect(reclaimed.body.browser).toMatchObject({
      status: "suspended",
      suspensionReason: "reconcile",
    });
    const healthy = await reconcileBrowsers(
      first.threadId,
      other.threadId,
      candidate.threadId,
    );
    expect(healthy.body).toMatchObject({
      checked: 2,
      stopped: 0,
      errors: 0,
      healthy: 2,
    });
    expect(providerStopAttempts).toStrictEqual([providerIds[0]]);

    // Each deletion can promote a queued run and revoke its marker on another
    // fixture thread. Settle that route-owned work before deleting the next one.
    for (const threadId of [
      first.threadId,
      other.threadId,
      candidate.threadId,
    ]) {
      await chat.deleteThread(actor, threadId);
      await flushWaitUntilForTest();
    }
    expect(providerStopAttempts).toStrictEqual([
      providerIds[0],
      providerIds[1],
      providerIds[2],
    ]);
  }, 120_000);

  it("reconciles only explicitly selected browser fixtures", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const target = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open the selected managed browser",
    );
    const sentinel = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open the untouched managed browser",
    );
    const providerIds = [randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    let providerCreates = 0;
    const stoppedProviderIds: string[] = [];
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const providerId = providerIds[providerCreates];
        providerCreates += 1;
        if (!providerId) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        const providerId = String(params.id);
        stoppedProviderIds.push(providerId);
        return HttpResponse.json(
          providerBrowser(providerId, { status: "stopped" }),
        );
      }),
    );

    await accept(
      client().use({ headers: target.claim.browserHeaders, body: {} }),
      [200],
    );
    await accept(
      client().use({ headers: sentinel.claim.browserHeaders, body: {} }),
      [200],
    );

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reconciled = await reconcileBrowsers(target.threadId);
    expect(reconciled.body).toStrictEqual({
      checked: 1,
      stopped: 1,
      errors: 0,
      healthy: 0,
    });
    await flushWaitUntilForTest();
    expect(stoppedProviderIds).toStrictEqual([providerIds[0]]);

    const untouched = await accept(
      client().get({
        headers: sentinel.claim.browserHeaders,
        params: { threadId: sentinel.threadId },
      }),
      [200],
    );
    expect(untouched.body.browser).toMatchObject({
      threadId: sentinel.threadId,
      status: "active",
    });

    await chat.deleteThread(actor, target.threadId);
    await chat.deleteThread(actor, sentinel.threadId);
    await flushWaitUntilForTest();
  }, 120_000);

  it("keeps the browser live across runs, lets its viewer resume, and reclaims its idle lease without retrying provider stop", async () => {
    const { routeMocks, runs, chat, webhooks, actor, runnerGroup, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    const savedTabUrls = [
      "https://example.com/research?q=one",
      "http://example.org/draft#section",
    ] as const;
    const cdpWebSocketUrls = [
      browserUseCdpWebSocketUrl(providerIds[0]),
      browserUseCdpWebSocketUrl(providerIds[1]),
      browserUseCdpWebSocketUrl(providerIds[2]),
    ] as const;
    let currentCdpWebSocketUrl: string | null = null;
    context.mocks.browserUseCdp.connect.mockImplementation((url) => {
      currentCdpWebSocketUrl = url;
    });
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method === "Target.getTargets") {
        if (currentCdpWebSocketUrl === cdpWebSocketUrls[0]) {
          return {
            targetInfos: [
              {
                targetId: "first-tab",
                type: "page",
                url: savedTabUrls[0],
              },
              {
                targetId: "duplicate-first-tab",
                type: "page",
                url: savedTabUrls[0],
              },
              {
                targetId: "second-tab",
                type: "page",
                url: savedTabUrls[1],
              },
              {
                targetId: "internal-tab",
                type: "page",
                url: "chrome://settings/",
              },
              {
                targetId: "embedded-page",
                type: "iframe",
                url: "https://example.net/embedded",
              },
            ],
          };
        }
        return {
          targetInfos: [
            {
              targetId: "default-tab",
              type: "page",
              url: "about:blank",
            },
          ],
        };
      }
      if (
        currentCdpWebSocketUrl === cdpWebSocketUrls[1] &&
        command.method === "Target.createTarget" &&
        command.params.url === savedTabUrls[0]
      ) {
        return new Error("test tab restoration failure");
      }
      if (
        currentCdpWebSocketUrl === cdpWebSocketUrls[2] &&
        command.method === "Browser.setContentsSize"
      ) {
        return new Error("test resize failure");
      }
      return undefined;
    });
    let providerCreates = 0;
    let providerStops = 0;
    let firstStopFailures = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(
        `${BROWSER_USE_API_URL}/browsers/:id`,
        async ({ params, request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            action: "stop",
          });
          const providerId = String(params.id);
          if (providerId === providerIds[0] && firstStopFailures === 0) {
            firstStopFailures += 1;
            return HttpResponse.json(
              { detail: "temporary Browser Use outage" },
              { status: 503 },
            );
          }
          providerStops += 1;
          return HttpResponse.json(
            providerBrowser(providerId, { status: "stopped" }),
          );
        },
      ),
    );

    const opened = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );
    const threadId = opened.body.browser.threadId;
    expect(opened.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(10 * MINUTE_MS),
      screen: {
        width: 1440,
        height: 900,
        resizable: true,
      },
    });
    expect(providerCreates).toBe(1);
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const fitted = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: { aspectRatio: 0.75 },
      }),
      [200],
    );
    expect(fitted.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 1920,
      resizable: true,
    });

    // The run ends without stopping the browser, and the thread's next message
    // starts a run right away instead of waiting for browser cleanup.
    mockNow(STARTED_AT_MS + 3 * MINUTE_MS);
    await webhooks.requestAgentComplete(
      { runId: first.runId, exitCode: 0 },
      first.claim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(providerStops).toBe(0);
    const released = await accept(
      client().get({
        headers: first.claim.browserHeaders,
        params: { threadId },
      }),
      [200],
    );
    expect(released.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(13 * MINUTE_MS),
    });

    await runs.heartbeatRunner(runnerGroup);
    mockNow(STARTED_AT_MS + 5 * MINUTE_MS);
    const followup = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: first.threadId,
        prompt: "Continue in the same browser",
      },
      [201],
    );
    if (followup.status !== 201 || followup.body.runId === null) {
      throw new Error("Expected the follow-up message to start a run");
    }
    const followupRunId = followup.body.runId;
    const followupClaim = await claimChatRun(runs, actor, followupRunId);

    // The next run attaches to the very same provider instance.
    const reused = await accept(
      client().use({ headers: followupClaim.browserHeaders, body: {} }),
      [200],
    );
    expect(reused.body.browser).toMatchObject({
      threadId: threadId,
      status: "active",
      idleExpiresAt: isoAt(15 * MINUTE_MS),
    });
    expect(providerCreates).toBe(1);

    const leased = await accept(
      client().lease({ headers: followupClaim.browserHeaders, body: {} }),
      [200],
    );
    expect(leased.body.browser).toMatchObject({
      threadId: threadId,
      idleExpiresAt: isoAt(15 * MINUTE_MS),
    });

    // Before the lease expires the reconciler leaves the browser alone.
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const healthy = await reconcileBrowsers(threadId);
    expect(healthy.body).toMatchObject({
      checked: 1,
      stopped: 0,
      errors: 0,
      healthy: 1,
    });
    expect(providerStops).toBe(0);

    mockNow(STARTED_AT_MS + 16 * MINUTE_MS);
    context.mocks.ably.publish.mockClear();
    const reclaimed = await reconcileBrowsers(threadId);
    expect(reclaimed.body).toMatchObject({
      stopped: 1,
      errors: 0,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "browserSessionChanged",
      { threadId },
    );
    await flushWaitUntilForTest();
    expect(firstStopFailures).toBe(1);
    expect(providerStops).toBe(0);
    const afterFailedStop = await reconcileBrowsers(threadId);
    expect(afterFailedStop.body).toMatchObject({
      checked: 0,
      stopped: 0,
      errors: 0,
    });
    expect(firstStopFailures).toBe(1);

    await accept(
      chatThreadComputerUseHostClient().update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: first.threadId },
        body: {
          computerUseHostId: null,
          cloudBrowserEnabled: false,
        },
      }),
      [204],
    );

    const agentRead = await accept(
      client().get({
        headers: followupClaim.browserHeaders,
        params: { threadId },
      }),
      [403],
    );
    expect(agentRead.body.error).toMatchObject({
      code: "BROWSER_AUTHORIZATION_REQUIRED",
    });

    const suspended = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
      }),
      [200],
    );
    expect(suspended.body.browser).toMatchObject({
      threadId: threadId,
      status: "suspended",
      suspensionReason: "idle",
      idleExpiresAt: null,
    });

    // The viewer can restore a reclaimed browser without a live run.
    context.mocks.ably.publish.mockClear();
    const resumedEventId = randomUUID();
    const resumed = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: { eventId: resumedEventId },
      }),
      [200],
    );
    expect(resumed.body.lifecycleEventId).toBe(resumedEventId);
    expect(resumed.body.browser).toMatchObject({
      threadId: threadId,
      status: "active",
      idleExpiresAt: isoAt(26 * MINUTE_MS),
      screen: {
        width: 1440,
        height: 1920,
        resizable: true,
      },
    });
    expect(providerCreates).toBe(2);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "browserSessionChanged",
      { threadId },
    );
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Browser.setContentsSize";
        }),
    ).toStrictEqual([
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 900 },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 1920 },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 1920 },
      },
    ]);
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return (
            command.method === "Target.createTarget" ||
            command.method === "Target.closeTarget"
          );
        }),
    ).toStrictEqual([
      {
        id: 2,
        method: "Target.createTarget",
        params: { url: savedTabUrls[0] },
      },
      {
        id: 3,
        method: "Target.createTarget",
        params: { url: savedTabUrls[1] },
      },
      {
        id: 4,
        method: "Target.closeTarget",
        params: { targetId: "default-tab" },
      },
    ]);

    mockNow(STARTED_AT_MS + 20 * MINUTE_MS);
    const viewerLease = await accept(
      client().leaseByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: {},
      }),
      [200],
    );
    expect(viewerLease.body.browser).toMatchObject({
      threadId: threadId,
      idleExpiresAt: isoAt(30 * MINUTE_MS),
    });

    mockNow(STARTED_AT_MS + 31 * MINUTE_MS);
    const reclaimedAgain = await reconcileBrowsers(threadId);
    expect(reclaimedAgain.body).toMatchObject({ stopped: 1, errors: 0 });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    const failedResume = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(`/api/chat-threads/${threadId}/browser/open`, {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventId: randomUUID() }),
    });
    expect(failedResume.status).toBe(502);
    await expect(failedResume.json()).resolves.toMatchObject({
      error: { code: "BROWSER_USE_RESIZE_ERROR" },
    });
    await flushWaitUntilForTest();
    expect(providerCreates).toBe(3);
    expect(providerStops).toBe(2);
    const afterFailedResume = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
      }),
      [200],
    );
    expect(afterFailedResume.body.browser.status).toBe("error");
    expect(afterFailedResume.body.browser).not.toHaveProperty("screen");

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);

    const reconciled = await reconcileBrowsers(threadId);
    expect(reconciled.body).toMatchObject({
      checked: 0,
      stopped: 0,
      errors: 0,
    });
  }, 120_000);

  it("deletes inactive browser state and its profile after seven days", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser that will expire",
    );
    const profileIds = [randomUUID(), randomUUID()] as const;
    const providerIds = [randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    const providerCreateBodies: unknown[] = [];
    const deletedProfiles: string[] = [];
    const savedTabUrl = "https://example.com/retained-tab";
    let profileCreates = 0;
    let providerCreates = 0;
    let providerStops = 0;
    let currentCdpWebSocketUrl: string | null = null;
    context.mocks.browserUseCdp.connect.mockImplementation((url) => {
      currentCdpWebSocketUrl = url;
    });
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method === "Target.getTargets") {
        return {
          targetInfos: [
            currentCdpWebSocketUrl === browserUseCdpWebSocketUrl(providerIds[0])
              ? {
                  targetId: "retained-tab",
                  type: "page",
                  url: savedTabUrl,
                }
              : {
                  targetId: "default-tab",
                  type: "page",
                  url: "about:blank",
                },
          ],
        };
      }
      if (command.method === "Target.attachToTarget") {
        return { sessionId: "foreground-session" };
      }
      if (command.method === "Runtime.evaluate") {
        return { result: { type: "boolean", value: true } };
      }
      if (command.method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1440,
            clientHeight: 900,
          },
        };
      }
      if (command.method === "Page.captureScreenshot") {
        return { data: Buffer.from("retained screenshot").toString("base64") };
      }
      return undefined;
    });
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        const profileId = profileIds[profileCreates];
        profileCreates += 1;
        if (!profileId) {
          return HttpResponse.json(
            { error: "unexpected profile create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerProfile(profileId, body.name), {
          status: 201,
        });
      }),
      http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, ({ params }) => {
        const profileId = String(params.id);
        deletedProfiles.push(profileId);
        if (profileId === profileIds[0] && deletedProfiles.length === 1) {
          return HttpResponse.json(
            { detail: "temporary Browser Use outage" },
            { status: 503 },
          );
        }
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, async ({ request }) => {
        providerCreateBodies.push(await request.json());
        const providerId = providerIds[providerCreates];
        providerCreates += 1;
        if (!providerId) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        providerStops += 1;
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    const created = await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
        body: { aspectRatio: 0.75 },
      }),
      [200],
    );

    mockNow(STARTED_AT_MS + MINUTE_MS);
    await reconcileBrowsers(current.threadId);
    await flushWaitUntilForTest();
    const withScreenshot = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    const screenshotUrl = withScreenshot.body.browser.screenshotUrl;
    if (!screenshotUrl) {
      throw new Error("Expected a retained browser screenshot");
    }
    const screenshotKey = new URL(screenshotUrl).pathname.slice(1);

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const stopped = await reconcileBrowsers(current.threadId);
    expect(stopped.body).toMatchObject({ stopped: 1, errors: 0 });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS + 7 * DAY_MS - 1);
    const retained = await reconcileBrowsers(current.threadId);
    expect(retained.body.errors).toBe(0);
    const beforeCutoff = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    expect(beforeCutoff.body.browser).toMatchObject({
      status: "suspended",
      screenshotUrl,
    });
    expect(deletedProfiles).toStrictEqual([]);

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS + 7 * DAY_MS);
    const failedCleanup = await reconcileBrowsers(current.threadId);
    expect(failedCleanup.body.errors).toBe(1);
    expect(deletedProfiles).toStrictEqual([profileIds[0]]);
    expect(providerStops).toBe(1);
    const afterFailedProfileDelete = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    expect(afterFailedProfileDelete.body.browser).toMatchObject({
      status: "suspended",
      screenshotUrl: null,
    });
    expect(afterFailedProfileDelete.body.browser).not.toHaveProperty("screen");
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        const input = commandInput(command);
        return (JSON.stringify(input.Delete) ?? "").includes(screenshotKey);
      }),
    ).toBeFalsy();

    const cleaned = await reconcileBrowsers(current.threadId);
    expect(cleaned.body).toMatchObject({ errors: 0 });
    expect(deletedProfiles).toStrictEqual([profileIds[0], profileIds[0]]);
    expect(providerStops).toBe(1);
    await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [404],
    );

    context.mocks.browserUseCdp.command.mockClear();
    const reopened = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
        body: { eventId: randomUUID() },
      }),
      [200],
    );
    expect(reopened.body.browser).toMatchObject({
      threadId: created.body.browser.threadId,
      status: "active",
      screenshotUrl: null,
      screen: { width: 1440, height: 900, resizable: true },
    });
    expect(profileCreates).toBe(2);
    expect(providerCreates).toBe(2);
    expect(
      z
        .strictObject({
          profileId: z.uuid(),
          proxyCountryCode: z.null(),
          timeout: z.literal(240),
          browserScreenWidth: z.literal(1440),
          browserScreenHeight: z.literal(900),
          allowResizing: z.literal(true),
          enableRecording: z.literal(false),
        })
        .parse(providerCreateBodies[1]).profileId,
    ).toBe(profileIds[1]);
    expect(
      context.mocks.browserUseCdp.command.mock.calls.some(([command]) => {
        return command.method === "Target.createTarget";
      }),
    ).toBeFalsy();

    await chat.deleteThread(actor, current.threadId);
    await flushWaitUntilForTest();
  }, 120_000);

  it("deduplicates previous snapshot URLs before restoring browser tabs", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Restore a managed browser snapshot",
    );

    const providerIds = [randomUUID(), randomUUID()] as const;
    const savedTabUrls = [
      "https://example.com/research?q=one",
      "http://example.org/draft#section",
    ] as const;
    const cdpWebSocketUrls = [
      `wss://${providerIds[0]}.cdp.browser-use.com/devtools/browser/test`,
      `wss://${providerIds[1]}.cdp.browser-use.com/devtools/browser/test`,
    ] as const;
    let currentCdpWebSocketUrl: string | null = null;
    context.mocks.browserUseCdp.connect.mockImplementation((url) => {
      currentCdpWebSocketUrl = url;
    });
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method !== "Target.getTargets") {
        return undefined;
      }
      if (currentCdpWebSocketUrl === cdpWebSocketUrls[0]) {
        return {
          targetInfos: [
            {
              targetId: "captured-tab",
              type: "page",
              url: savedTabUrls[0],
            },
          ],
        };
      }
      return {
        targetInfos: [
          {
            targetId: "default-tab",
            type: "page",
            url: "about:blank",
          },
        ],
      };
    });
    let providerCreates = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const providerId = providerIds[providerCreates];
        providerCreates += 1;
        if (!providerId) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(providerId), {
          status: 201,
        });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      ...providerIds.map((providerId, index) => {
        const webSocketUrl = cdpWebSocketUrls[index];
        return http.get(
          `https://${providerId}.cdp.browser-use.com/json/version`,
          () => {
            return HttpResponse.json({
              webSocketDebuggerUrl: webSocketUrl,
            });
          },
        );
      }),
      ...cdpWebSocketUrls.map((webSocketUrl) => {
        return browserUseCdpHandler(webSocketUrl);
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    const opened = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );
    const threadId = opened.body.browser.threadId;
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reclaimed = await reconcileBrowsers(threadId);
    expect(reclaimed.body).toMatchObject({ stopped: 1, errors: 0 });
    await flushWaitUntilForTest();

    // This historical snapshot shape cannot be produced through the current
    // capture path because capture now deduplicates before persistence.
    await setBrowserTabSnapshotAsPreviousApi(context, {
      threadId,
      tabUrls: [
        savedTabUrls[0],
        savedTabUrls[0],
        savedTabUrls[1],
        savedTabUrls[0],
        savedTabUrls[1],
      ],
    });
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const resumed = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: { eventId: randomUUID() },
      }),
      [200],
    );
    expect(resumed.body.browser.status).toBe("active");
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Target.createTarget";
        }),
    ).toStrictEqual([
      {
        id: 2,
        method: "Target.createTarget",
        params: { url: savedTabUrls[0] },
      },
      {
        id: 3,
        method: "Target.createTarget",
        params: { url: savedTabUrls[1] },
      },
    ]);

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
  }, 120_000);

  it.each(["no_page_target", "target_disappeared", "other", "timeout"])(
    "absorbs a %s screenshot failure and keeps the browser usable",
    async (failureKind) => {
      const { routeMocks, runs, chat, actor, agent } =
        await setupBrowserScenario();
      const current = await createClaimedChatRun(
        chat,
        runs,
        actor,
        agent.agentId,
        "Open a browser without a screenshot",
      );
      const providerId = randomUUID();
      acceptBrowserUseCdpSessions([providerId]);
      server.use(
        http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
          const body = z
            .strictObject({ name: z.string() })
            .parse(await request.json());
          return HttpResponse.json(providerProfile(randomUUID(), body.name), {
            status: 201,
          });
        }),
        http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
          return HttpResponse.json(providerBrowser(providerId), {
            status: 201,
          });
        }),
        http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
          return HttpResponse.json(providerBrowser(String(params.id)));
        }),
      );
      await accept(
        client().use({ headers: current.claim.browserHeaders, body: {} }),
        [200],
      );
      await flushWaitUntilForTest();
      context.mocks.browserUseCdp.command.mockImplementation((command) => {
        if (
          command.method === "Target.getTargets" &&
          failureKind === "no_page_target"
        ) {
          return { targetInfos: [] };
        }
        if (command.method === "Target.attachToTarget") {
          if (failureKind === "target_disappeared") {
            return new Error("No target with given id found");
          }
          return { sessionId: "foreground-session" };
        }
        if (command.method === "Runtime.evaluate") {
          return { result: { type: "boolean", value: true } };
        }
        if (command.method === "Page.getLayoutMetrics") {
          return {
            cssVisualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 1280,
              clientHeight: 720,
            },
          };
        }
        if (command.method === "Page.captureScreenshot") {
          return failureKind === "other"
            ? new Error("Screenshot capture unavailable")
            : { data: Buffer.from("screenshot").toString("base64") };
        }
        return undefined;
      });
      if (failureKind === "timeout") {
        // Node storage transports can wrap the deadline in an AbortError.
        const timeout = new Error("The operation was aborted", {
          cause: new DOMException(
            "Screenshot deadline exceeded",
            "TimeoutError",
          ),
        });
        timeout.name = "AbortError";
        context.mocks.s3.send.mockImplementation((command: unknown) => {
          return commandInput(command).ContentType === "image/webp"
            ? Promise.reject(timeout)
            : Promise.resolve({});
        });
      }

      const reconciled = await reconcileBrowsers(current.threadId);
      expect(reconciled.body).toMatchObject({ healthy: 1, errors: 0 });
      await flushWaitUntilForTest();

      routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const lease = await accept(
        client().leaseByThread({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
          body: {},
        }),
        [200],
      );
      expect(lease.body.browser).toMatchObject({
        status: "active",
        screenshotUrl: null,
      });
      await flushWaitUntilForTest();
      expect(
        context.mocks.browserUseCdp.command.mock.calls.filter(([command]) => {
          return command.method === "Page.captureScreenshot";
        }),
      ).toHaveLength(
        failureKind === "other" || failureKind === "timeout" ? 1 : 0,
      );
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          const input = commandInput(command);
          return input.ContentType === "image/webp" || "Delete" in input;
        }),
      ).toHaveLength(failureKind === "timeout" ? 1 : 0);
      expect(context.mocks.sentry.captureException.mock.calls).toStrictEqual(
        [],
      );
    },
    120_000,
  );

  it("captures the foreground tab and keeps previous screenshot objects when updating or deleting a thread", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser for screenshot capture",
    );
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );
    const releaseSecondScreenshotUpload = createDeferredPromise<void>(
      context.signal,
    );
    const releaseThirdScreenshotUpload = createDeferredPromise<void>(
      context.signal,
    );
    let screenshotUploadCount = 0;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      if (input.ContentType === "image/webp") {
        screenshotUploadCount += 1;
        if (screenshotUploadCount === 2) {
          return releaseSecondScreenshotUpload.promise;
        }
        if (screenshotUploadCount === 3) {
          return releaseThirdScreenshotUpload.promise;
        }
      }
      return Promise.resolve({});
    });
    let captureCount = 0;
    let failNextCapture = false;
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              targetId: "background-page",
              type: "page",
              url: "https://background.example.com",
            },
            {
              targetId: "foreground-page",
              type: "page",
              url: "https://foreground.example.com",
            },
          ],
        };
      }
      if (command.method === "Target.attachToTarget") {
        return {
          sessionId:
            command.params.targetId === "foreground-page"
              ? "foreground-session"
              : "background-session",
        };
      }
      if (command.method === "Runtime.evaluate") {
        return {
          result: {
            type: "boolean",
            value: command.sessionId === "foreground-session",
          },
        };
      }
      if (command.method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            pageX: 0,
            pageY: 24,
            clientWidth: 1280,
            clientHeight: 720,
          },
        };
      }
      if (command.method === "Page.captureScreenshot") {
        if (failNextCapture) {
          return new Error("Screenshot capture unavailable");
        }
        captureCount += 1;
        return {
          data: Buffer.from(`screenshot-${String(captureCount)}`).toString(
            "base64",
          ),
        };
      }
      return undefined;
    });

    await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const firstLease = await accept(
      client().leaseByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
        body: {},
      }),
      [200],
    );
    expect(firstLease.body.browser.screenshotUrl).toBeNull();
    await flushWaitUntilForTest();
    expect(captureCount).toBe(0);

    const afterViewerLease = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    expect(afterViewerLease.body.browser.screenshotUrl).toBeNull();

    const firstReconcile = await reconcileBrowsers(current.threadId);
    expect(firstReconcile.body).toMatchObject({
      errors: 0,
    });
    await flushWaitUntilForTest();

    const afterFirstCapture = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    const firstScreenshotUrl = afterFirstCapture.body.browser.screenshotUrl;
    expect(firstScreenshotUrl).toMatch(/^https:\/\/a\.okou\.io\/.+\.webp$/u);
    if (!firstScreenshotUrl) {
      throw new Error("Expected the first browser screenshot URL");
    }
    const firstScreenshotKey = `artifacts/${new URL(firstScreenshotUrl).pathname.slice(1)}`;
    const screenshotPut = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command);
      })
      .find((input) => {
        return input.ContentType === "image/webp";
      });
    expect(screenshotPut?.Metadata).toMatchObject({
      "public-brand": "okou",
    });

    const secondLease = await accept(
      client().leaseByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
        body: {},
      }),
      [200],
    );
    expect(secondLease.body.browser.screenshotUrl).toBe(firstScreenshotUrl);
    await flushWaitUntilForTest();
    expect(captureCount).toBe(1);

    const secondReconcile = await reconcileBrowsers(current.threadId);
    expect(secondReconcile.body).toMatchObject({
      errors: 0,
    });
    releaseSecondScreenshotUpload.resolve(undefined);
    await flushWaitUntilForTest();

    const afterSecondCapture = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    const secondScreenshotUrl = afterSecondCapture.body.browser.screenshotUrl;
    expect(secondScreenshotUrl).not.toBe(firstScreenshotUrl);
    if (!secondScreenshotUrl) {
      throw new Error("Expected the second browser screenshot URL");
    }
    const secondScreenshotKey = `artifacts/${new URL(secondScreenshotUrl).pathname.slice(1)}`;
    expect(captureCount).toBe(2);
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Page.captureScreenshot";
        }),
    ).toStrictEqual([
      {
        id: 7,
        method: "Page.captureScreenshot",
        params: {
          format: "webp",
          quality: 80,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: {
            x: 0,
            y: 24,
            width: 1280,
            height: 720,
            scale: 0.5,
          },
        },
        sessionId: "foreground-session",
      },
      {
        id: 7,
        method: "Page.captureScreenshot",
        params: {
          format: "webp",
          quality: 80,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: {
            x: 0,
            y: 24,
            width: 1280,
            height: 720,
            scale: 0.5,
          },
        },
        sessionId: "foreground-session",
      },
    ]);

    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        const input = commandInput(command);
        return (JSON.stringify(input.Delete) ?? "").includes(
          firstScreenshotKey,
        );
      }),
    ).toHaveLength(0);
    const thirdReconcile = await reconcileBrowsers(current.threadId);
    expect(thirdReconcile.body).toMatchObject({
      errors: 0,
    });
    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        const input = commandInput(command);
        return (JSON.stringify(input.Delete) ?? "").includes(
          firstScreenshotKey,
        );
      }),
    ).toHaveLength(0);
    releaseThirdScreenshotUpload.resolve(undefined);
    await flushWaitUntilForTest();

    const afterThirdCapture = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    const finalScreenshotUrl = afterThirdCapture.body.browser.screenshotUrl;
    expect(finalScreenshotUrl).not.toBe(secondScreenshotUrl);
    if (!finalScreenshotUrl) {
      throw new Error("Expected the third browser screenshot URL");
    }
    const finalScreenshotKey = `artifacts/${new URL(finalScreenshotUrl).pathname.slice(1)}`;
    expect(captureCount).toBe(3);
    failNextCapture = true;
    const failedCapture = await reconcileBrowsers(current.threadId);
    expect(failedCapture.body).toMatchObject({ healthy: 1, errors: 0 });
    await flushWaitUntilForTest();
    const retainedPreview = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    expect(retainedPreview.body.browser).toMatchObject({
      status: "active",
      screenshotUrl: finalScreenshotUrl,
    });
    expect(context.mocks.sentry.captureException.mock.calls).toStrictEqual([]);
    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        const input = commandInput(command);
        return (JSON.stringify(input.Delete) ?? "").includes(
          secondScreenshotKey,
        );
      }),
    ).toHaveLength(0);

    await chat.deleteThread(actor, current.threadId);
    await flushWaitUntilForTest();
    expect(context.mocks.s3.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Delete: { Objects: [{ Key: finalScreenshotKey }] },
        }),
      }),
    );

    const reconciled = await reconcileBrowsers(current.threadId);
    expect(reconciled.body).toMatchObject({
      errors: 0,
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Delete: { Objects: [{ Key: finalScreenshotKey }] },
        }),
      }),
    );
  }, 120_000);

  it("reclaims an active browser after its thread is already deleted", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let providerStops = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        providerStops += 1;
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );

    await deleteChatThreadRootFixture(first.threadId);
    const reclaimed = await reconcileBrowsers(first.threadId);
    expect(reclaimed.body).toStrictEqual({
      checked: 2,
      stopped: 2,
      errors: 0,
      healthy: 0,
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);

    const retired = await reconcileBrowsers(first.threadId);
    expect(retired.body).toStrictEqual({
      checked: 0,
      stopped: 0,
      errors: 0,
      healthy: 0,
    });
    await deleteAgentRunRootFixture(first.runId);
  }, 120_000);

  it("records browser lifecycle events only for UI actions and automatic reclamation", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    let providerCreates = 0;
    let providerStops = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        const providerId = String(params.id);
        if (
          providerIds.some((id) => {
            return id === providerId;
          })
        ) {
          providerStops += 1;
        }
        return HttpResponse.json(
          providerBrowser(providerId, { status: "stopped" }),
        );
      }),
    );

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const beforeStartCloseEventId = randomUUID();
    await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: beforeStartCloseEventId },
      }),
      [200],
    );

    const firstStart = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );
    expect(firstStart.body.lifecycleEventId).toBeNull();

    const beforeReclaimCloseEventId = randomUUID();
    await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: beforeReclaimCloseEventId },
      }),
      [200],
    );

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reclaimed = await reconcileBrowsers(first.threadId);
    expect(reclaimed.body).toMatchObject({
      errors: 0,
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);
    const resumed = await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "replacement", proxyCountryCode: null },
      }),
      [201],
    );
    expect(resumed.body.browser).toMatchObject({
      threadId: firstStart.body.browser.threadId,
      status: "active",
    });
    expect(resumed.body.lifecycleEventId).toBeNull();
    expect(providerCreates).toBe(2);

    const openEventId = randomUUID();
    const alreadyActive = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: openEventId },
      }),
      [200],
    );
    expect(alreadyActive.body).toMatchObject({
      lifecycleEventId: openEventId,
      browser: { threadId: first.threadId, status: "active" },
    });

    const closeEventId = randomUUID();
    const closed = await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: closeEventId },
      }),
      [200],
    );
    expect(closed.body).toStrictEqual({
      lifecycleEventId: closeEventId,
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);
    const stillActive = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
      }),
      [200],
    );
    expect(stillActive.body.browser.status).toBe("active");

    const events = await readProjectedChatEvents(context, {
      threadId: first.threadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(
      events.flatMap((event) => {
        return event.eventType === "browser.open" ||
          event.eventType === "browser.close"
          ? [
              {
                id: event.id,
                eventType: event.eventType,
                content: event.content,
              },
            ]
          : [];
      }),
    ).toStrictEqual([
      {
        id: beforeStartCloseEventId,
        eventType: "browser.close",
        content: null,
      },
      {
        id: beforeReclaimCloseEventId,
        eventType: "browser.close",
        content: null,
      },
      {
        id: expect.any(String),
        eventType: "browser.close",
        content: null,
      },
      {
        id: openEventId,
        eventType: "browser.open",
        content: null,
      },
      {
        id: closeEventId,
        eventType: "browser.close",
        content: null,
      },
    ]);

    const collided = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(`/api/chat-threads/${first.threadId}/browser/close`, {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventId: closeEventId }),
    });
    expect(collided.status).toBe(409);
    await expect(collided.json()).resolves.toMatchObject({
      error: { code: "BROWSER_EVENT_ID_CONFLICT" },
    });
    expect(providerCreates).toBe(2);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);
  }, 120_000);
});
