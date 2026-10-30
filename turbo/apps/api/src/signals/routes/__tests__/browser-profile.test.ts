import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { object, strictObject, string, uuid } from "zod";

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

const context = testContext();
const PROVIDER_URL = "https://api.browser-use.com/api/v3";
const STARTED_AT = Date.parse("2026-07-24T10:00:00.000Z");

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

describe("Browser thread profiles", () => {
  it("preserves each thread's profile when restarting its provider", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    mockEnv("APP_URL", "https://app.okou.ai");
    const chat = createChatFilesBddApi(context);
    const threadIds: string[] = [];
    const profiles = new Set<string>();
    const sessions = new Map<
      string,
      { readonly profileId: string; status: "active" | "stopped" }
    >();

    function providerSession(
      id: string,
      session: {
        readonly profileId: string;
        readonly status: "active" | "stopped";
      },
    ) {
      const active = session.status === "active";
      return {
        id,
        status: session.status,
        liveUrl: active
          ? `https://live.browser-use.com/?wss=${session.profileId}`
          : null,
        cdpUrl: active ? `https://${id}.cdp.browser-use.com/` : null,
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
        const { name } = strictObject({ name: string() }).parse(
          await request.json(),
        );
        const id = randomUUID();
        profiles.add(id);
        return HttpResponse.json(
          {
            id,
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
      http.delete(`${PROVIDER_URL}/profiles/:id`, ({ params }) => {
        profiles.delete(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${PROVIDER_URL}/browsers`, async ({ request }) => {
        const { profileId } = object({ profileId: uuid() }).parse(
          await request.json(),
        );
        if (!profiles.has(profileId)) {
          return HttpResponse.json(
            { detail: "profile is unavailable" },
            { status: 404 },
          );
        }
        const id = randomUUID();
        const session = { profileId, status: "active" as const };
        sessions.set(id, session);
        const webSocketUrl = `wss://${id}.cdp.browser-use.com/devtools/browser/test`;
        server.use(
          http.get(`https://${id}.cdp.browser-use.com/json/version`, () => {
            return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
          }),
          browserUseCdpHandler(webSocketUrl),
        );
        return HttpResponse.json(providerSession(id, session), { status: 201 });
      }),
      http.get(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
        const id = String(params.id);
        const session = sessions.get(id);
        return session
          ? HttpResponse.json(providerSession(id, session))
          : HttpResponse.json(
              { detail: "browser is unavailable" },
              { status: 404 },
            );
      }),
      http.patch(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
        const id = String(params.id);
        const session = sessions.get(id);
        if (!session) {
          return HttpResponse.json(
            { detail: "browser is unavailable" },
            { status: 404 },
          );
        }
        session.status = "stopped";
        return HttpResponse.json(providerSession(id, session));
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
      async function startThread(prompt: string) {
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
        const connection = await accept(
          client().use({ headers, body: {} }),
          [200],
        );
        const params = { threadId: sent.threadId };
        const observed = await accept(client().get({ headers, params }), [200]);
        expect(observed.body.browser).toMatchObject({
          threadId: sent.threadId,
          status: "active",
        });
        expect(observed.body.browser.liveUrl).toMatch(
          /^https:\/\/live\.browser-use\.com\/\?wss=/u,
        );
        return {
          headers,
          params,
          connection: connection.body,
          browser: observed.body.browser,
        };
      }

      const first = await startThread("Keep my booking Browser profile");
      const other = await startThread(
        "Use a separate research Browser profile",
      );
      expect(other.browser.liveUrl).not.toBe(first.browser.liveUrl);
      expect(other.connection.cdpUrl).not.toBe(first.connection.cdpUrl);

      for (const [current, untouched] of [
        [first, other],
        [other, first],
      ] as const) {
        // The external provider stops the instance; the normal use route resumes it.
        const id = new URL(current.connection.cdpUrl).hostname.split(".")[0];
        const provider = id ? sessions.get(id) : undefined;
        if (!provider) {
          throw new Error("Expected the returned provider Browser");
        }
        provider.status = "stopped";
        const resumed = await accept(
          client().use({ headers: current.headers, body: {} }),
          [200],
        );
        expect(resumed.body.cdpUrl).not.toBe(current.connection.cdpUrl);
        const observed = await accept(
          client().get({ headers: current.headers, params: current.params }),
          [200],
        );
        expect(observed.body.browser).toMatchObject({
          threadId: current.params.threadId,
          status: "active",
          liveUrl: current.browser.liveUrl,
        });
        const unchanged = await accept(
          client().get({
            headers: untouched.headers,
            params: untouched.params,
          }),
          [200],
        );
        expect(unchanged.body.browser.liveUrl).toBe(untouched.browser.liveUrl);
        const reused = await accept(
          client().use({ headers: current.headers, body: {} }),
          [200],
        );
        expect(reused.body.cdpUrl).toBe(resumed.body.cdpUrl);
      }
    });
  });
});
