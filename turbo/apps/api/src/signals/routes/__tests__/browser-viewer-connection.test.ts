import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { object, string } from "zod";

import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const PROVIDER_URL = "https://api.browser-use.com/api/v3";
const STARTED_AT = Date.parse("2026-07-24T10:00:00.000Z");
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

async function viewerScenario() {
  mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
  mockEnv("APP_URL", "https://app.okou.ai");
  const providerId = randomUUID();
  const cdpUrl = `https://${providerId}.cdp.browser-use.com/`;
  const webSocketUrl = `wss://${providerId}.cdp.browser-use.com/devtools/browser/test?token=a%26b`;
  const provider = {
    status: "active" as "active" | "stopped",
    cdpUrl,
    liveUrl: `https://live.browser-use.com/?wss=${encodeURIComponent(cdpUrl)}`,
    discoveryUrl: webSocketUrl,
  };
  function providerSession() {
    const active = provider.status === "active";
    return {
      id: providerId,
      status: provider.status,
      liveUrl: active ? provider.liveUrl : null,
      cdpUrl: active ? provider.cdpUrl : null,
      extensions: [TEST_BROWSER_EXTENSION],
      timeoutAt: new Date(STARTED_AT + 240 * 60_000).toISOString(),
      startedAt: new Date(STARTED_AT).toISOString(),
      finishedAt: active ? null : new Date(STARTED_AT).toISOString(),
      agentSessionId: null,
      recordingUrl: null,
    };
  }
  server.use(
    http.post(`${PROVIDER_URL}/profiles`, async ({ request }) => {
      const { name } = object({ name: string() }).parse(await request.json());
      return HttpResponse.json(
        {
          id: randomUUID(),
          userId: null,
          name,
          lastUsedAt: null,
          createdAt: new Date(STARTED_AT).toISOString(),
          updatedAt: new Date(STARTED_AT).toISOString(),
          cookieDomains: null,
        },
        { status: 201 },
      );
    }),
    http.delete(`${PROVIDER_URL}/profiles/:id`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${PROVIDER_URL}/browsers`, () => {
      return HttpResponse.json(providerSession(), { status: 201 });
    }),
    http.get(`${PROVIDER_URL}/browsers/:id`, () => {
      return HttpResponse.json(providerSession());
    }),
    http.patch(`${PROVIDER_URL}/browsers/:id`, () => {
      provider.status = "stopped";
      return HttpResponse.json(providerSession());
    }),
    http.get(`${cdpUrl}json/version`, () => {
      return HttpResponse.json({ webSocketDebuggerUrl: provider.discoveryUrl });
    }),
    browserUseCdpHandler(webSocketUrl),
  );
  const chat = createChatFilesBddApi(context);
  const threadIds: string[] = [];
  const owned = await publicChatActor(context, {
    optionalEnvironmentNames: ["OKOU_BROWSER_USE_API_KEY"],
    clockTime: STARTED_AT,
    beforeWorkspaceCleanup: async (actor) => {
      for (const threadId of threadIds) {
        await chat.deleteThread(actor, threadId);
        await flushWaitUntilForTest();
      }
    },
  });
  const current = await owned.run(async () => {
    const sent = await chat.sendAndLaunch(owned.actor, {
      agentId: owned.agentId,
      prompt: "Open my browser viewer",
      cloudBrowserEnabled: true,
    });
    threadIds.push(sent.threadId);
    const claimed = await owned.claimChatRun(owned.runnerGroup, sent.runId);
    const runHeaders = {
      authorization: `Bearer ${okouTokenFromClaim(claimed.claim)}`,
    };
    await accept(client().use({ headers: runHeaders, body: {} }), [200]);
    return { params: { threadId: sent.threadId }, runHeaders };
  });
  const orgId = owned.actor.orgId;
  if (!orgId) {
    throw new Error("Expected a browser workspace");
  }
  return {
    ...owned,
    ...current,
    provider,
    webSocketUrl,
    orgId,
  };
}

test("retrieves a viewer connection for its signed-in owner", async () => {
  const scenario = await viewerScenario();
  await scenario.run(async () => {
    const { params } = scenario;
    // A later release changes configuration, not the installed artifact of this Browser.
    mockEnv("OKOU_BROWSER_USE_EXTENSION_ID", randomUUID());
    createRouteMocks(context).clerk.session(
      scenario.actor.userId,
      scenario.actor.orgId,
    );
    const connected = await accept(
      client().viewerConnection({ headers, params }),
      [200],
    );
    expect(connected.body).toStrictEqual({
      cdpUrl: scenario.webSocketUrl,
      extension: TEST_BROWSER_EXTENSION,
    });
    expect(connected.headers.get("cache-control")).toBe("no-store");
    const deniedRun = await client().viewerConnection({
      headers: scenario.runHeaders,
      params,
    });
    expect(deniedRun.status).toBe(403);

    const foreign = { userId: `user_${randomUUID()}`, orgId: scenario.orgId };
    createRouteMocks(context).clerk.session(foreign.userId, foreign.orgId);
    const foreignResponse = await client().viewerConnection({
      headers,
      params,
    });
    expect(foreignResponse).toMatchObject({
      status: 404,
      body: { error: { code: "BROWSER_NOT_FOUND" } },
    });
    createRouteMocks(context).clerk.session(
      scenario.actor.userId,
      scenario.actor.orgId,
    );
    scenario.provider.status = "stopped";
    const stopped = await client().viewerConnection({ headers, params });
    expect(stopped).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_NOT_LIVE" } },
    });
  });
});

test.each(["provider WSS", "live WSS", "double-encoded live WSS"] as const)(
  "reuses %s without requiring HTTPS discovery",
  async (source) => {
    const scenario = await viewerScenario();
    await scenario.run(async () => {
      // A failed discovery endpoint proves the already resolved WSS is sufficient.
      scenario.provider.discoveryUrl = "not-a-websocket";
      if (source === "provider WSS") {
        scenario.provider.cdpUrl = scenario.webSocketUrl;
      } else {
        const endpoint =
          source === "double-encoded live WSS"
            ? encodeURIComponent(scenario.webSocketUrl)
            : scenario.webSocketUrl;
        scenario.provider.liveUrl = `https://live.browser-use.com/?wss=${encodeURIComponent(endpoint)}`;
      }
      const connected = await accept(
        client().viewerConnection({ headers, params: scenario.params }),
        [200],
      );
      expect(connected.body).toStrictEqual({
        cdpUrl: scenario.webSocketUrl,
        extension: TEST_BROWSER_EXTENSION,
      });
      // Teardown also uses the normal provider discovery path.
      scenario.provider.discoveryUrl = scenario.webSocketUrl;
    });
  },
);

test("rejects an untrusted discovery endpoint without returning provider payloads", async () => {
  const scenario = await viewerScenario();
  await scenario.run(async () => {
    scenario.provider.discoveryUrl = "wss://untrusted.example/private-token";
    const response = await client().viewerConnection({
      headers,
      params: scenario.params,
    });
    expect(response).toMatchObject({
      status: 502,
      body: {
        error: {
          code: "BROWSER_USE_DISCOVERY_ERROR",
          message: "Managed browser provider could not connect the viewer",
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("private-token");
    scenario.provider.discoveryUrl = scenario.webSocketUrl;
  });
});
