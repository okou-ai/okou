import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { array, object, string, uuid } from "zod";

import { createApp } from "../../../app-factory";
import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, onRejection } from "../../utils";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const PROVIDER_URL = "https://api.browser-use.com/api/v3";
const STARTED_AT = Date.parse("2026-07-24T10:00:00.000Z");
const EXTENSION_ID = randomUUID();
const createBrowserSchema = object({
  profileId: uuid(),
  extensionIds: array(uuid()).length(1),
});

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function providerFixture(rejectCreate = false) {
  const requests: ReturnType<typeof createBrowserSchema.parse>[] = [];
  const created = createDeferredPromise<void>(context.signal);
  const installed = createDeferredPromise<void>(context.signal);
  const discoveries: string[] = [];
  const sessions = new Map<string, { status: "active" | "stopped" }>();
  function completeInstallation() {
    if (!installed.settled()) {
      installed.resolve();
    }
  }
  onTestFinished(completeInstallation);

  function session(id: string, status: "active" | "stopped") {
    const webSocketUrl = `wss://${id}.cdp.browser-use.com/devtools/browser/test`;
    return {
      id,
      status,
      liveUrl:
        status === "active"
          ? `https://live.browser-use.com/?wss=${encodeURIComponent(webSocketUrl)}`
          : null,
      cdpUrl: status === "active" ? `https://${id}.cdp.browser-use.com/` : null,
      extensions: [{ ...TEST_BROWSER_EXTENSION, id: EXTENSION_ID }],
      timeoutAt: new Date(STARTED_AT + 240 * 60_000).toISOString(),
      startedAt: new Date(STARTED_AT).toISOString(),
      finishedAt:
        status === "active" ? null : new Date(STARTED_AT).toISOString(),
    };
  }

  server.use(
    http.post(`${PROVIDER_URL}/profiles`, async ({ request }) => {
      const { name } = object({ name: string() }).parse(await request.json());
      return HttpResponse.json(
        {
          id: randomUUID(),
          name,
          createdAt: new Date(STARTED_AT).toISOString(),
          updatedAt: new Date(STARTED_AT).toISOString(),
        },
        { status: 201 },
      );
    }),
    http.delete(`${PROVIDER_URL}/profiles/:id`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${PROVIDER_URL}/browsers`, async ({ request }) => {
      requests.push(createBrowserSchema.parse(await request.json()));
      if (!created.settled()) {
        created.resolve();
      }
      await installed.promise;
      if (rejectCreate) {
        return HttpResponse.json(
          { detail: "Requested extension is unavailable" },
          { status: 422 },
        );
      }
      const id = randomUUID();
      const webSocketUrl = `wss://${id}.cdp.browser-use.com/devtools/browser/test`;
      sessions.set(id, { status: "active" });
      server.use(
        http.get(`https://${id}.cdp.browser-use.com/json/version`, () => {
          discoveries.push(id);
          return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
        }),
        browserUseCdpHandler(webSocketUrl),
      );
      return HttpResponse.json(session(id, "active"), { status: 201 });
    }),
    http.get(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
      const id = String(params.id);
      const current = sessions.get(id);
      return current
        ? HttpResponse.json(session(id, current.status))
        : HttpResponse.json({ detail: "Browser not found" }, { status: 404 });
    }),
    http.patch(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
      const id = String(params.id);
      const current = sessions.get(id);
      if (!current) {
        return HttpResponse.json(
          { detail: "Browser not found" },
          { status: 404 },
        );
      }
      current.status = "stopped";
      return HttpResponse.json(session(id, "stopped"));
    }),
  );
  return {
    requests,
    created: created.promise,
    completeInstallation,
    discoveries,
  };
}

async function browserOwner() {
  mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
  mockEnv("APP_URL", "https://app.okou.ai");
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
  owned.ownsFeatureSwitches();
  const orgId = owned.actor.orgId;
  if (!orgId) {
    throw new Error("Expected a browser workspace owner");
  }
  return {
    owned,
    actor: { ...owned.actor, orgId },
    async startRun() {
      const sent = await chat.sendAndLaunch(owned.actor, {
        agentId: owned.agentId,
        prompt: "Open a managed browser",
        cloudBrowserEnabled: true,
      });
      threadIds.push(sent.threadId);
      const claimed = await owned.claimChatRun(owned.runnerGroup, sent.runId);
      return {
        authorization: `Bearer ${okouTokenFromClaim(claimed.claim)}`,
      };
    },
  };
}

describe("Browser extensions", () => {
  it("installs configured extensions before CDP and keeps the running instance", async () => {
    mockEnv("OKOU_BROWSER_USE_EXTENSION_ID", ` ${EXTENSION_ID} `);
    const provider = providerFixture();
    const { owned, actor, startRun } = await browserOwner();
    await owned.run(async () => {
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.BrowserSharedOwner]: true,
      });
      const headers = await startRun();
      const pending = client().use({ headers, body: {} });
      const started = await onRejection(
        (async () => {
          await provider.created;
          expect(provider.requests).toHaveLength(1);
          expect(provider.requests[0]?.extensionIds).toStrictEqual([
            EXTENSION_ID,
          ]);
          expect(provider.discoveries).toStrictEqual([]);
          provider.completeInstallation();
          return accept(pending, [200]);
        })(),
        async () => {
          provider.completeInstallation();
          await pending;
        },
      );
      expect(started.body.browser.status).toBe("active");
      expect(provider.discoveries.length).toBeGreaterThan(0);

      mockEnv("OKOU_BROWSER_USE_EXTENSION_ID", randomUUID());
      const reused = await accept(client().use({ headers, body: {} }), [200]);
      expect(reused.body.browser.status).toBe("active");
      expect(provider.requests).toHaveLength(1);
    });
  });

  it("installs the required extension with legacy Browser ownership", async () => {
    mockEnv("OKOU_BROWSER_USE_EXTENSION_ID", EXTENSION_ID);
    const provider = providerFixture();
    provider.completeInstallation();
    const { owned, actor, startRun } = await browserOwner();
    await owned.run(async () => {
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.BrowserSharedOwner]: false,
      });
      const headers = await startRun();
      const started = await accept(client().use({ headers, body: {} }), [200]);
      expect(started.body.browser.status).toBe("active");
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.extensionIds).toStrictEqual([EXTENSION_ID]);
    });
  });

  it("returns installation failures without CDP or an extension-free retry", async () => {
    mockEnv("OKOU_BROWSER_USE_EXTENSION_ID", EXTENSION_ID);
    const provider = providerFixture(true);
    provider.completeInstallation();
    const { owned, actor, startRun } = await browserOwner();
    await owned.run(async () => {
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.BrowserSharedOwner]: true,
      });
      const headers = await startRun();
      const failed = await createApp({
        signal: context.signal,
        routes: browserRoutes,
      }).request("/api/browsers/use", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(failed.status).toBe(502);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.extensionIds).toStrictEqual([EXTENSION_ID]);
      expect(provider.discoveries).toStrictEqual([]);
    });
  });
});
