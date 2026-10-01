import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { installAutomaticMcpCatalog } from "./helpers/connector-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);
const headers = { authorization: "Bearer clerk-session" } as const;

describe("builtin Automatic firewall credential destinations", () => {
  it.each([
    [
      "refreshes labels for the same verified principal",
      "builtin-refresh-user",
      200,
    ],
    [
      "requires reconnect for a different verified principal",
      "builtin-other-user",
      502,
    ],
  ] as const)("%s", async (_title, refreshedSubject, expectedStatus) => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const catalog = await installAutomaticMcpCatalog();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      initialExpiresIn: 3600,
      identity: {
        subject: "builtin-refresh-user",
        userInfoUsername: "builtin-before-refresh",
        userInfoEmail: "builtin-preserved@example.test",
      },
      refreshIdentity: {
        subject: refreshedSubject,
        userInfoUsername: "builtin-after-refresh",
      },
    });
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const firewall = createFirewallApi(context);
    const connectors = createConnectorBddApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP identity refresh",
    });
    const automatic = setupApp({
      context,
      routes: builtinConnectorsAutomaticRoutes,
    })(builtinConnectorAutomaticContract);
    const accounts = setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    );
    mocks.clerk.session(actor.userId, actor.orgId);
    const started = await accept(
      automatic.start({
        headers,
        params: { connectorSlug: catalog.slug },
        body: {
          authMethod: catalog.methodId,
          account: { intent: "add" },
          agentId: agent.agentId,
          authorizeAgent: true,
        },
      }),
      [200],
    );
    if (started.body.result !== "authorization") {
      throw new Error("Expected Automatic OAuth authorization");
    }
    const state = new URL(started.body.authorizationUrl).searchParams.get(
      "state",
    );
    if (!state) {
      throw new Error("Expected OAuth state");
    }
    expect(
      (
        await accept(
          automatic.callback({
            query: {
              state,
              code: "identity-refresh-code",
              iss: provider.issuer,
              responseMode: "json",
            },
          }),
          [200],
        )
      ).body.status,
    ).toBe("success");
    const connectionId = (
      await accept(
        accounts.oauthCompletion({
          headers,
          params: { attemptId: started.body.oauthAttemptId },
          query: catalog.target,
        }),
        [200],
      )
    ).body.connectionId;
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the refreshed MCP identity",
      modelProvider: "anthropic-api-key",
    });
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);
    const builtin = claim.firewalls?.find((entry) => {
      return entry.kind === "builtin" && entry.name === catalog.slug;
    });
    if (builtin?.kind !== "builtin") {
      throw new Error("Expected the builtin Automatic firewall");
    }
    const refreshed = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      {
        encryptedSecrets:
          claim.encryptedSecrets ?? firewall.encryptedSecretsBody({}),
        authHeaders: catalog.firewallAuthHeaders,
        forceRefresh: true,
        matchedFirewall: {
          name: catalog.slug,
          apiId: `${catalog.slug}:0`,
          base: catalog.endpoint,
          connectorSlug: catalog.slug,
          sourceId: connectionId,
          routingVariables: {},
        },
      },
      [200, 502],
    );
    expect(refreshed.status).toBe(expectedStatus);
    if (expectedStatus === 200) {
      expect(refreshed.body).toMatchObject({
        headers: {
          Authorization: "Bearer automatic-refreshed-access-token",
        },
      });
    } else {
      expect(refreshed.body).toMatchObject({
        error: {
          code: "TOKEN_REFRESH_FAILED",
          failureReason: "reconnect_required",
        },
      });
      expect(JSON.stringify(refreshed.body)).not.toContain(
        "automatic-refreshed-access-token",
      );
    }
    const account = await accept(
      accounts.connection({
        headers,
        params: { connectionId },
        query: catalog.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      externalId: "builtin-refresh-user",
      externalUsername:
        expectedStatus === 200
          ? "builtin-after-refresh"
          : "builtin-before-refresh",
      externalEmail: "builtin-preserved@example.test",
      connectionStatus:
        expectedStatus === 200 ? "connected" : "reconnect-required",
      reconnectReason:
        expectedStatus === 200 ? null : "authorization_expired_or_revoked",
    });

    await runs.requestCancelRun(actor, run.runId, [200]);
    await connectors.deleteBuiltinConnectorAccount(
      actor,
      catalog.slug,
      connectionId,
    );
    await bdd.deleteAgent(actor, agent.agentId);
  });

  it.each(["timeout", "provider failure", "recovery"] as const)(
    "classifies Automatic refresh $0 without marking reconnect",
    async (outcomeKind) => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      if (outcomeKind === "timeout") {
        mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", "25");
      }
      onTestFinished(() => {
        mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", undefined);
      });
      const catalog = await installAutomaticMcpCatalog();
      const refreshAborted = createDeferredPromise<void>(context.signal);
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
        initialExpiresIn: 3600,
        refreshResponse: async (attempt, signal) => {
          if (outcomeKind === "timeout") {
            const markAborted = () => {
              if (!refreshAborted.settled()) {
                refreshAborted.resolve();
              }
            };
            if (signal.aborted) {
              markAborted();
            } else {
              signal.addEventListener("abort", markAborted, { once: true });
            }
            await refreshAborted.promise;
            return HttpResponse.error();
          }
          if (
            outcomeKind === "provider failure" ||
            (outcomeKind === "recovery" && attempt === 1)
          ) {
            return HttpResponse.json(
              { error: "temporarily_unavailable" },
              { status: 503 },
            );
          }
          return HttpResponse.json({
            access_token: "recovered-automatic-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      });
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const firewall = createFirewallApi(context);
      const connectors = createConnectorBddApi(context);
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: `MCP refresh ${outcomeKind}`,
      });
      const automatic = setupApp({
        context,
        routes: builtinConnectorsAutomaticRoutes,
      })(builtinConnectorAutomaticContract);
      const accounts = setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      );
      mocks.clerk.session(actor.userId, actor.orgId);
      const started = await accept(
        automatic.start({
          headers,
          params: { connectorSlug: catalog.slug },
          body: {
            authMethod: catalog.methodId,
            account: { intent: "add" },
            agentId: agent.agentId,
            authorizeAgent: true,
          },
        }),
        [200],
      );
      if (started.body.result !== "authorization") {
        throw new Error("Expected Automatic OAuth authorization");
      }
      const state = new URL(started.body.authorizationUrl).searchParams.get(
        "state",
      );
      if (!state) {
        throw new Error("Expected OAuth state");
      }
      const callback = await accept(
        automatic.callback({
          query: {
            state,
            code: "authorized-code",
            iss: provider.issuer,
            responseMode: "json",
          },
        }),
        [200],
      );
      expect(callback.body.status).toBe("success");
      const receipt = await accept(
        accounts.oauthCompletion({
          headers,
          params: { attemptId: started.body.oauthAttemptId },
          query: catalog.target,
        }),
        [200],
      );
      const connectionId = receipt.body.connectionId;
      const run = await runs.createRun(actor, {
        agentId: agent.agentId,
        prompt: "Use the selected MCP account",
        modelProvider: "anthropic-api-key",
      });
      const outcome = await settleIncludingAbort(
        (async () => {
          await runs.heartbeatRunner(runnerGroup);
          const claim = await runs.claimRunnerJob(run.runId);
          const builtin = claim.firewalls?.find((entry) => {
            return entry.kind === "builtin" && entry.name === catalog.slug;
          });
          if (builtin?.kind !== "builtin") {
            throw new Error("Expected the builtin Automatic firewall");
          }
          const authHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
          const body = {
            encryptedSecrets:
              claim.encryptedSecrets ?? firewall.encryptedSecretsBody({}),
            authHeaders: catalog.firewallAuthHeaders,
            forceRefresh: true,
            matchedFirewall: {
              name: catalog.slug,
              apiId: `${catalog.slug}:0`,
              base: catalog.endpoint,
              connectorSlug: catalog.slug,
              sourceId: connectionId,
              routingVariables: {},
            },
          };
          if (outcomeKind === "recovery") {
            const failed = await firewall.requestFirewallAuth(
              authHeaders,
              body,
              [502],
            );
            if (failed.status !== 502) {
              throw new Error(
                "Expected Automatic refresh failure before recovery",
              );
            }
            expect(failed.body.error).toMatchObject({
              code: "TOKEN_REFRESH_FAILED",
              failureReason: "upstream_provider",
              connectors: [catalog.slug],
            });
            const response = await firewall.requestFirewallAuth(
              authHeaders,
              body,
              [200],
            );
            if (response.status !== 200) {
              throw new Error("Expected Automatic refresh recovery");
            }
            expect(response.body.headers.Authorization).toBe(
              "Bearer recovered-automatic-token",
            );
            return;
          }
          const response = await firewall.requestFirewallAuth(
            authHeaders,
            body,
            [502],
          );
          if (response.status !== 502) {
            throw new Error("Expected Automatic refresh failure");
          }
          expect(response.body.error).toMatchObject({
            code: "TOKEN_REFRESH_FAILED",
            failureReason: "upstream_provider",
            connectors: [catalog.slug],
          });
          const account = await accept(
            accounts.connection({
              headers,
              params: { connectionId },
              query: catalog.target,
            }),
            [200],
          );
          expect(account.body).toMatchObject({
            connectionStatus: "connected",
            reconnectReason: null,
          });
        })(),
      );
      await runs.requestCancelRun(actor, run.runId, [200]);
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        catalog.slug,
        connectionId,
      );
      await bdd.deleteAgent(actor, agent.agentId);
      if (!outcome.ok) {
        throw outcome.error;
      }
    },
  );
});
