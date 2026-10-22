import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const PROVIDER_URL = "https://api.browser-use.com/api/v3";
const STARTED_AT = Date.parse("2026-07-24T10:00:00.000Z");

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

describe("Browser start publication", () => {
  it("keeps a browser unpublished when its provider identity already exists", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    mockEnv("APP_URL", "https://app.okou.ai");
    const chat = createChatFilesBddApi(context);
    const threadIds: string[] = [];
    const providerId = randomUUID();
    let providerStatus: "active" | "stopped" = "active";
    const webSocketUrl = `wss://${providerId}.cdp.browser-use.com/devtools/browser/test`;
    function providerSession() {
      const active = providerStatus === "active";
      return {
        id: providerId,
        status: providerStatus,
        liveUrl: active
          ? `https://live.browser-use.com/?wss=${providerId}`
          : null,
        cdpUrl: active ? `https://${providerId}.cdp.browser-use.com/` : null,
        timeoutAt: new Date(STARTED_AT + 240 * 60_000).toISOString(),
        startedAt: new Date(STARTED_AT).toISOString(),
        finishedAt: active ? null : new Date(STARTED_AT).toISOString(),
        agentSessionId: null,
        recordingUrl: null,
      };
    }
    server.use(
      http.post(`${PROVIDER_URL}/profiles`, async ({ request }) => {
        const { name } = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
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
        providerStatus = "stopped";
        return HttpResponse.json(providerSession());
      }),
      http.get(`https://${providerId}.cdp.browser-use.com/json/version`, () => {
        return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
      }),
      browserUseCdpHandler(webSocketUrl),
    );
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
    await owned.run(async () => {
      async function startRun(prompt: string) {
        const sent = await chat.sendAndLaunch(owned.actor, {
          agentId: owned.agentId,
          prompt,
          cloudBrowserEnabled: true,
        });
        threadIds.push(sent.threadId);
        const claimed = await owned.claimChatRun(owned.runnerGroup, sent.runId);
        return {
          threadId: sent.threadId,
          headers: {
            authorization: `Bearer ${okouTokenFromClaim(claimed.claim)}`,
          },
        };
      }
      const first = await startRun("Open the first managed browser");
      const active = await accept(
        client().use({ headers: first.headers, body: {} }),
        [200],
      );
      expect(active.body.browser).toMatchObject({
        threadId: first.threadId,
        status: "active",
        screen: { width: 1440, height: 900, resizable: true },
      });

      const second = await startRun("Open another managed browser");
      const failed = await createApp({
        signal: context.signal,
        routes: browserRoutes,
      }).request("/api/browsers/use", {
        method: "POST",
        headers: { ...second.headers, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(failed.status).toBe(500);
      await flushWaitUntilForTest();
      const current = await accept(
        client().current({ headers: second.headers }),
        [200],
      );
      expect(current.body.browser).toMatchObject({
        threadId: second.threadId,
        status: "creating",
      });
      expect(current.body.browser).not.toHaveProperty("screen");
    });
  });
});
