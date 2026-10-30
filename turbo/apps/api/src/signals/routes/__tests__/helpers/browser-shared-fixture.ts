import { randomUUID } from "node:crypto";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { object, record, strictObject, string } from "zod";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { withNowScopeForTest } from "../../../../lib/time";
import { browserRoutes } from "../../browser";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunsApi } from "./api-bdd-runs";
import { requireOrgId, okouTokenFromClaim } from "./chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { publicChatActor } from "./public-chat-actor";
import { createNativeWindowProvider } from "./browser-native-window";
import { TEST_BROWSER_EXTENSION } from "../../../../__tests__/browser-extension";

export const START = Date.parse("2026-10-25T14:00:00.000Z");
export const MINUTE = 60_000;
export const PROVIDER_URL = "https://api.browser-use.com/api/v3";

export function createSharedBrowserFixtures(context: TestContext) {
  const runs = createRunsApi(context);

  function profileProvider(beforeResponse?: () => Promise<void>) {
    const native = createNativeWindowProvider(context);
    const sessionIds = new Set<string>();
    const stoppedSessionIds = new Set<string>();
    const sessionMetadata = new Map<string, Record<string, string>>();
    const profiles = new Map<
      string,
      { readonly id: string; readonly name: string }
    >();
    const createdIds: string[] = [];
    const sessionRequests: unknown[] = [];
    function profile(id: string, name = "owned-provider-profile") {
      return {
        id,
        name,
        createdAt: new Date(START).toISOString(),
        updatedAt: new Date(START).toISOString(),
      };
    }
    const handlers = [
      native.handler,
      http.post(`${PROVIDER_URL}/browsers`, async ({ request }) => {
        const input: unknown = await request.json();
        sessionRequests.push(input);
        const id = randomUUID();
        sessionMetadata.set(
          id,
          object({ metadata: record(string(), string()).optional() }).parse(
            input,
          ).metadata ?? {},
        );
        sessionIds.add(id);
        const initialPage = {
          targetId: randomUUID(),
          windowId: 0,
          url: "about:blank",
        };
        native.targets.set(initialPage.targetId, initialPage);
        native.created.push(initialPage);
        return HttpResponse.json(
          {
            id,
            status: "active",
            startedAt: new Date(START).toISOString(),
            timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
            finishedAt: null,
            liveUrl: "https://live.browser-use.com/owned-fixture",
            cdpUrl: native.url,
            extensions: [TEST_BROWSER_EXTENSION],
          },
          { status: 201 },
        );
      }),
      http.get(`${PROVIDER_URL}/browsers`, ({ request }) => {
        const term = new URL(request.url).searchParams.get("metadata");
        const items = [...sessionMetadata]
          .filter(([, metadata]) => {
            return term === `okouInstanceId=${metadata.okouInstanceId}`;
          })
          .map(([id, metadata]) => {
            return { id, metadata };
          });
        return HttpResponse.json({
          items,
          totalItems: items.length,
          pageNumber: 1,
          pageSize: 2,
        });
      }),
      http.patch(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
        if (
          !sessionIds.has(String(params.id)) &&
          !stoppedSessionIds.has(String(params.id))
        ) {
          return;
        }
        sessionIds.delete(String(params.id));
        stoppedSessionIds.add(String(params.id));
        native.targets.clear();
        native.nativeWindowErrors.clear();
        return HttpResponse.json({
          id: String(params.id),
          status: "stopped",
          startedAt: new Date(START).toISOString(),
          timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
          finishedAt: new Date(START).toISOString(),
          liveUrl: null,
          cdpUrl: null,
        });
      }),
      http.get(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
        const active = sessionIds.has(String(params.id));
        if (!active && !stoppedSessionIds.has(String(params.id))) {
          return;
        }
        return HttpResponse.json({
          id: String(params.id),
          status: active ? "active" : "stopped",
          startedAt: new Date(START).toISOString(),
          timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
          finishedAt: active ? null : new Date(START).toISOString(),
          liveUrl: active ? "https://live.browser-use.com/owned-fixture" : null,
          cdpUrl: active ? native.url : null,
          extensions: [TEST_BROWSER_EXTENSION],
        });
      }),
      http.post(`${PROVIDER_URL}/profiles`, async ({ request }) => {
        const { name } = strictObject({ name: string() }).parse(
          await request.json(),
        );
        const id = randomUUID();
        profiles.set(id, { id, name });
        createdIds.push(id);
        await beforeResponse?.();
        return HttpResponse.json(profile(id, name), { status: 201 });
      }),
      http.get(`${PROVIDER_URL}/profiles/:id`, ({ params }) => {
        const stored = profiles.get(String(params.id));
        return stored
          ? HttpResponse.json(profile(stored.id, stored.name))
          : HttpResponse.json({ detail: "Profile missing" }, { status: 404 });
      }),
      http.delete(`${PROVIDER_URL}/profiles/:id`, ({ params }) => {
        profiles.delete(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    ];
    return {
      handlers,
      createdIds,
      profile,
      native,
      sessionIds,
      sessionRequests,
      stoppedSessionIds,
      sessionMetadata,
    };
  }

  function client() {
    return setupApp({ context, routes: browserRoutes })(browserContract);
  }

  async function fixture(enabled = true, provider = profileProvider()) {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "owner-profile-test-key");
    server.use(...provider.handlers);
    const owned = await publicChatActor(context, {
      clockTime: START,
      optionalEnvironmentNames: ["OKOU_BROWSER_USE_API_KEY"],
    });
    const featureActor = { ...owned.actor, orgId: requireOrgId(owned.actor) };
    const chat = createChatFilesBddApi(context);
    if (enabled) {
      owned.ownsFeatureSwitches();
      await owned.run(() => {
        return updateFeatureSwitchesForUser(context, featureActor, {
          [FeatureSwitchKey.BrowserSharedOwner]: true,
        });
      });
    }
    async function start(browserEnabled = true) {
      return await owned.run(async () => {
        const sent = await chat.sendAndLaunch(owned.actor, {
          agentId: owned.agentId,
          prompt: "Prepare my chat-owned Browser lifetime",
          cloudBrowserEnabled: browserEnabled,
        });
        const runnerIdentity = {
          runnerId: randomUUID(),
          heartbeatGeneration: 7,
        };
        await withNowScopeForTest(() => {
          return runs.requestHeartbeatRunner(true, [200], {
            group: owned.runnerGroup,
            runnerId: runnerIdentity.runnerId,
            snapshotGeneration: runnerIdentity.heartbeatGeneration,
          });
        });
        const claim = await owned.claimRunnerRun(sent.runId, {
          runnerIdentity,
        });
        return { ...sent, runnerIdentity, claim, provider };
      });
    }
    return { owned, start, featureActor, provider };
  }

  type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;

  async function open(chat: Chat) {
    const result = await accept(
      client().use({
        headers: { authorization: `Bearer ${okouTokenFromClaim(chat.claim)}` },
        body: {},
      }),
      [200],
    );
    return result.body.browser;
  }

  async function view(chat: Chat) {
    const result = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: chat.threadId },
      }),
      [200],
    );
    return result.body.browser;
  }

  async function renew(chat: Chat) {
    const result = await accept(
      client().leaseByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: chat.threadId },
        body: {},
      }),
      [200],
    );
    return result.body.browser;
  }

  return { fixture, profileProvider, open, view, renew };
}
