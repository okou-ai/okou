import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { strictObject, string } from "zod";

import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const PROVIDER_URL = "https://api.browser-use.com/api/v3";
const STARTED_AT = Date.parse("2026-07-24T10:00:00.000Z");
const MINUTE_MS = 60_000;

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

describe("Browser run and viewer authorization", () => {
  it("keeps each run within its own thread for reads, leases, resizing and viewer actions", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    mockEnv("APP_URL", "https://app.okou.ai");
    const chat = createChatFilesBddApi(context);
    const threadIds: string[] = [];
    const sessions = new Map<string, "active" | "stopped">();

    function providerSession(id: string, status: "active" | "stopped") {
      const active = status === "active";
      return {
        id,
        status,
        liveUrl: active ? `https://live.browser-use.com/?wss=${id}` : null,
        cdpUrl: active ? `https://${id}.cdp.browser-use.com/` : null,
        extensions: [TEST_BROWSER_EXTENSION],
        timeoutAt: new Date(STARTED_AT + 240 * MINUTE_MS).toISOString(),
        startedAt: new Date(STARTED_AT).toISOString(),
        finishedAt: active ? null : new Date(STARTED_AT).toISOString(),
        agentSessionId: null,
        recordingUrl: null,
      };
    }

    server.use(
      http.post(`${PROVIDER_URL}/profiles`, async ({ request }) => {
        const { name } = strictObject({ name: string() }).parse(
          await request.json(),
        );
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
        const id = randomUUID();
        sessions.set(id, "active");
        const webSocketUrl = `wss://${id}.cdp.browser-use.com/devtools/browser/test`;
        server.use(
          http.get(`https://${id}.cdp.browser-use.com/json/version`, () => {
            return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
          }),
          browserUseCdpHandler(webSocketUrl),
        );
        return HttpResponse.json(providerSession(id, "active"), {
          status: 201,
        });
      }),
      http.get(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
        const id = String(params.id);
        const status = sessions.get(id);
        return status
          ? HttpResponse.json(providerSession(id, status))
          : HttpResponse.json(
              { detail: "browser is unavailable" },
              { status: 404 },
            );
      }),
      http.patch(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
        const id = String(params.id);
        if (!sessions.has(id)) {
          return HttpResponse.json(
            { detail: "browser is unavailable" },
            { status: 404 },
          );
        }
        sessions.set(id, "stopped");
        return HttpResponse.json(providerSession(id, "stopped"));
      }),
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
      async function startThread(prompt: string, mode: "create" | "use") {
        const sent = await chat.sendAndLaunch(owned.actor, {
          agentId: owned.agentId,
          prompt,
          cloudBrowserEnabled: true,
        });
        threadIds.push(sent.threadId);
        const claimed = await owned.claimChatRun(owned.runnerGroup, sent.runId);
        const headers = {
          authorization: `Bearer ${okouTokenFromClaim(claimed.claim)}`,
        };
        const params = { threadId: sent.threadId };
        if (mode === "create") {
          await accept(
            client().create({
              headers,
              body: { name: "first-context", proxyCountryCode: null },
            }),
            [201],
          );
        } else {
          await accept(client().use({ headers, body: {} }), [200]);
        }
        const current = await accept(client().current({ headers }), [200]);
        expect(current.body.browser).toMatchObject({
          threadId: sent.threadId,
          status: "active",
          idleExpiresAt: new Date(STARTED_AT + 10 * MINUTE_MS).toISOString(),
        });
        return { headers, params };
      }

      const first = await startThread(
        "Open this run's managed Browser",
        "create",
      );
      const other = await startThread(
        "Use a different thread's Browser",
        "use",
      );
      expect(other.params.threadId).not.toBe(first.params.threadId);

      for (const [current, foreign, minutes] of [
        [first, other, 1],
        [other, first, 2],
      ] as const) {
        mockNow(STARTED_AT + minutes * MINUTE_MS);
        const before = await accept(
          client().get({ headers: current.headers, params: current.params }),
          [200],
        );
        expect(before.body.browser).toMatchObject({
          threadId: current.params.threadId,
          status: "active",
          screen: { width: 1440, height: 900, resizable: true },
        });
        for (const response of [
          await client().get({
            headers: foreign.headers,
            params: current.params,
          }),
          await client().leaseByThread({
            headers: foreign.headers,
            params: current.params,
            body: {},
          }),
          await client().resizeByThread({
            headers: foreign.headers,
            params: current.params,
            body: { aspectRatio: 2 },
          }),
          await client().close({
            headers: foreign.headers,
            params: current.params,
            body: {},
          }),
          await client().open({
            headers: foreign.headers,
            params: current.params,
            body: {},
          }),
        ]) {
          expect(response).toMatchObject({
            status: 404,
            body: { error: { code: "BROWSER_NOT_FOUND" } },
          });
        }
        const unchanged = await accept(
          client().get({ headers: current.headers, params: current.params }),
          [200],
        );
        expect(unchanged.body.browser).toMatchObject({
          threadId: current.params.threadId,
          status: "active",
          liveUrl: before.body.browser.liveUrl,
          idleExpiresAt: before.body.browser.idleExpiresAt,
          screen: before.body.browser.screen,
        });
        const leased = await accept(
          client().lease({ headers: current.headers, body: {} }),
          [200],
        );
        expect(leased.body.browser).toMatchObject({
          threadId: current.params.threadId,
          idleExpiresAt: new Date(
            STARTED_AT + (minutes + 10) * MINUTE_MS,
          ).toISOString(),
        });
        const closed = await accept(
          client().close({
            headers: current.headers,
            params: current.params,
            body: {},
          }),
          [200],
        );
        expect(closed.body).toStrictEqual({});
        const observed = await accept(
          client().get({ headers: current.headers, params: current.params }),
          [200],
        );
        expect(observed.body.browser).toMatchObject({
          threadId: current.params.threadId,
          status: "active",
          liveUrl: before.body.browser.liveUrl,
          idleExpiresAt: leased.body.browser.idleExpiresAt,
        });
      }
    });
  });
});
