import { randomUUID } from "node:crypto";
import {
  runnerBrowserContract,
  type RunnerBrowserAction,
  type RunnerBrowserResponse,
} from "@okouai/api-contracts/contracts/runner-browser";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect } from "vitest";
import { HttpResponse, http } from "msw";
import { strictObject, string } from "zod";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { withNowScopeForTest } from "../../../../lib/time";
import { runnerBrowserRoutes } from "../../runner-browser";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunsApi } from "./api-bdd-runs";
import { requireOrgId } from "./chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { publicChatActor } from "./public-chat-actor";
import { createNativeWindowProvider } from "./browser-native-window";

export const START = Date.parse("2026-10-25T14:00:00.000Z");
export const MINUTE = 60_000;
export const PROVIDER_URL = "https://api.browser-use.com/api/v3";

export function createRunnerBrowserFixtures(context: TestContext) {
  const runs = createRunsApi(context);

  function profileProvider(beforeResponse?: () => Promise<void>) {
    const native = createNativeWindowProvider(context);
    const sessionIds = new Set<string>();
    const stoppedSessionIds = new Set<string>();
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
        sessionRequests.push(await request.json());
        const id = randomUUID();
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
          },
          { status: 201 },
        );
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
    };
  }

  function client() {
    return setupApp({ context, routes: runnerBrowserRoutes })(
      runnerBrowserContract,
    );
  }

  function officialHeaders() {
    return {
      authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
    };
  }

  function accepted(result: RunnerBrowserResponse) {
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") {
      throw new Error("Expected an accepted Browser lifecycle operation");
    }
    return result.instance;
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
        function control(action: RunnerBrowserAction) {
          if (action.kind === "publish") {
            // The trusted caller publishes an already-created external
            // session. Keep that provider fixture scoped to its exact ID.
            provider.sessionIds.add(action.providerSessionId);
          }
          return client().control({
            headers: officialHeaders(),
            params: { runId: sent.runId },
            body: { runnerIdentity, action },
          });
        }
        async function request(action: RunnerBrowserAction) {
          const result = await accept(control(action), [200]);
          return result.body;
        }
        return { ...sent, runnerIdentity, claim, request, control, provider };
      });
    }
    return { owned, start, featureActor, provider };
  }

  type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;

  async function allocate(chat: Chat) {
    const instance = accepted(await chat.request({ kind: "allocate" }));
    return accepted(
      await chat.request({
        kind: "publish",
        instanceId: instance.id,
        providerSessionId: randomUUID(),
        timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
      }),
    );
  }

  async function admit(
    chat: Chat,
    instanceId: string,
    primaryWindowId: number,
  ) {
    chat.provider.native.windowIds.splice(
      0,
      chat.provider.native.windowIds.length,
      primaryWindowId,
    );
    const instance = accepted(
      await chat.request({ kind: "admit", instanceId }),
    );
    expect(instance.window).toMatchObject({ primaryWindowId, state: "active" });
    return { instanceId, primaryWindowId };
  }

  return {
    fixture,
    profileProvider,
    client,
    officialHeaders,
    accepted,
    allocate,
    admit,
  };
}
