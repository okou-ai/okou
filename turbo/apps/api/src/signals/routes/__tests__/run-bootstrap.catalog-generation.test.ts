import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { publicRunOwner } from "./helpers/public-run-owner";

const context = testContext();

async function connectorActor() {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const connectors = createConnectorBddApi(context);
  const actor = bdd.user();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  const agents: string[] = [];
  const providerIds: string[] = [];
  const owner = publicRunOwner(context, actor, {
    afterRuns: async () => {
      for (const agentId of agents) {
        await bdd.deleteAgent(actor, agentId);
      }
      for (const id of providerIds) {
        await createAuthDeviceSupportApi(
          context,
        ).deletePersonalModelProviderAccount(actor, id);
      }
      for (const slug of ["openai", "x"] as const) {
        for (const account of await connectors.listBuiltinConnectorAccounts(
          actor,
          slug,
        )) {
          await connectors.deleteBuiltinConnectorAccount(
            actor,
            slug,
            account.id,
          );
        }
      }
    },
  });
  return await owner.run(async () => {
    await publicPlanLifecycle(context, actor).update("active");
    await bdd.completeOnboarding(actor);
    const provider = await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    providerIds.push(provider.providerId);
    const agent = await bdd.createAgent(actor, {
      displayName: "Connector selection",
      visibility: "private",
    });
    agents.push(agent.agentId);
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    server.use(
      http.post("https://api.x.com/2/oauth2/token", () => {
        return HttpResponse.json({
          access_token: "x-selection-access",
          refresh_token: "x-selection-refresh",
          token_type: "Bearer",
          scope: "",
        });
      }),
      http.get("https://api.x.com/2/users/me", () => {
        return HttpResponse.json({
          data: {
            id: "selection-x",
            username: "selection-x",
            name: "Selection X",
          },
        });
      }),
    );
    const started = await connectors.requestOauthStart(actor, "x", "oauth", {
      statuses: [200],
    });
    if (started.status !== 200) {
      throw new Error("Expected X OAuth start");
    }
    const state = new URL(started.body.authorizationUrl).searchParams.get(
      "state",
    );
    if (!state) {
      throw new Error("Expected issued OAuth state");
    }
    const connected = await connectors.completeOauthCallbackResult("x", {
      state,
      code: `selection-${randomUUID()}`,
    });
    expect(connected.body.status).toBe("success");
    return {
      actor,
      agentId: agent.agentId,
      api,
      connectors,
      async send(prompt: string, threadId?: string) {
        return await api.createThreadRun(actor, {
          agentId: agent.agentId,
          prompt,
          threadId,
          model: "claude-fable-5-1",
        });
      },
      async claim(runId: string) {
        await api.heartbeatRunner(runnerGroup);
        return await owner.claim(runId);
      },
      async cancel(runId: string, token: string) {
        await api.requestCancelRun(actor, runId, [200]);
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${token}` },
          [200],
        );
        await flushWaitUntilForTest();
      },
    };
  });
}

describe("Run connector selection through normal user changes", () => {
  it("omits a connected but unselected connector from a real Runner claim", async () => {
    const fixture = await connectorActor();
    const { actor, agentId, api } = fixture;
    await api.enableAgentConnectors(actor, agentId, []);
    const run = await fixture.send("omit an unselected connector");
    const claim = await fixture.claim(run.runId);
    expect(claim.environment ?? {}).not.toHaveProperty("X_TOKEN");
    expect(claim.secretConnectorMap ?? {}).not.toHaveProperty("X_TOKEN");
    expect(
      claim.firewalls?.some((entry) => {
        return entry.kind === "builtin" && entry.name === "x";
      }),
    ).toBeFalsy();
    expect(claim.billableFirewalls).not.toContain("x");
    expect(claim.networkPolicies ?? {}).not.toHaveProperty("x");
    expect(claim).not.toHaveProperty("connectorPermissionBaseline");
    await fixture.cancel(run.runId, claim.sandboxToken);
  });

  it("keeps prepared connector selections while a subsequent Run uses the user's new selection", async () => {
    const fixture = await connectorActor();
    const { actor, agentId, api, connectors } = fixture;
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: `bootstrap-owned-${randomUUID()}` },
      agentId,
    );
    await api.enableAgentConnectors(actor, agentId, ["openai"]);
    const prepared = await fixture.send("use the prepared connector selection");
    await api.enableAgentConnectors(actor, agentId, ["x"]);
    const claimed = await fixture.claim(prepared.runId);
    expect(claimed.secretConnectorMetadataMap?.OPENAI_TOKEN).toMatchObject({
      sourceId: connection.id,
    });
    expect(claimed.environment ?? {}).not.toHaveProperty("X_TOKEN");
    expect(claimed.secretConnectorMap ?? {}).not.toHaveProperty("X_TOKEN");
    await fixture.cancel(prepared.runId, claimed.sandboxToken);
    const next = await fixture.send(
      "use the new connector selection",
      prepared.threadId,
    );
    const nextClaim = await fixture.claim(next.runId);
    expect(nextClaim.secretConnectorMetadataMap?.OPENAI_TOKEN).toBeUndefined();
    expect(nextClaim.environment).toHaveProperty("X_TOKEN");
    expect(nextClaim.secretConnectorMap).toHaveProperty("X_TOKEN");
    await fixture.cancel(next.runId, nextClaim.sandboxToken);
  });
});
