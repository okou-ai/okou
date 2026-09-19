import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { HttpResponse } from "msw";
import { delay } from "signal-timers";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { holdConnectorAccountFixture } from "../../../test-fixtures/connector-account-lock";
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

const context = testContext();
const mocks = createRouteMocks(context);
const headers = { authorization: "Bearer clerk-session" } as const;

describe("builtin Automatic firewall credential destinations", () => {
  it.each([
    ["endpoint", "before auth"],
    ["endpoint", "while auth waits"],
    ["endpoint", "during refresh"],
    ["auth", "during refresh"],
  ] as const)(
    "rejects a stale catalog %s when the catalog changes %s without runtime sync",
    async (changedContract, timing) => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      const catalog = await installAutomaticMcpCatalog();
      const refreshGate =
        timing === "during refresh"
          ? {
              entered: createDeferredPromise<void>(context.signal),
              release: createDeferredPromise<void>(context.signal),
            }
          : null;
      const initialProvider = mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
        initialExpiresIn: 3600,
        ...(refreshGate
          ? {
              refreshResponse: async () => {
                refreshGate.entered.resolve();
                await refreshGate.release.promise;
                return HttpResponse.json({
                  access_token: "refreshed-old-endpoint-access-token",
                  token_type: "Bearer",
                  expires_in: 3600,
                });
              },
            }
          : {}),
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
        displayName: "MCP endpoint binding",
      });
      const automatic = setupApp({
        context,
        routes: builtinConnectorsAutomaticRoutes,
      })(builtinConnectorAutomaticContract);
      const accounts = setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      );
      async function connect(issuer: string, connectionId?: string) {
        mocks.clerk.session(actor.userId, actor.orgId);
        const started = await accept(
          automatic.start({
            headers,
            params: { connectorSlug: catalog.slug },
            body: {
              authMethod: catalog.methodId,
              agentId: agent.agentId,
              authorizeAgent: true,
              account: connectionId
                ? { intent: "reconnect", connectionId }
                : { intent: "add" },
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
              iss: issuer,
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
        return receipt.body.connectionId;
      }
      const connectionId = await connect(initialProvider.issuer);
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
          const originalBase = catalog.endpoint;
          const nextEndpoint = "https://replacement-mcp.example.test/server";
          const authHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
          function request(base: string | undefined, forceRefresh = false) {
            return firewall.requestFirewallAuth(
              authHeaders,
              {
                encryptedSecrets:
                  claim.encryptedSecrets ?? firewall.encryptedSecretsBody({}),
                authHeaders: catalog.firewallAuthHeaders,
                forceRefresh,
                matchedFirewall: {
                  name: catalog.slug,
                  apiId: `${catalog.slug}:0`,
                  connectorSlug: catalog.slug,
                  sourceId: connectionId,
                  routingVariables: {},
                  ...(base === undefined ? {} : { base }),
                },
              },
              base === nextEndpoint ? [200] : [424],
            );
          }
          async function updateCatalog() {
            await installAutomaticMcpCatalog({
              ...catalog,
              endpoint:
                changedContract === "endpoint" ? nextEndpoint : originalBase,
              firewallAuth: changedContract === "auth" ? "none" : "oauth",
              isolateSource: false,
            });
          }
          if (timing === "while auth waits") {
            if (!actor.orgId) {
              throw new Error("Expected the account's organization");
            }
            // Hold a real database row to pause resolution after it captured A;
            // construct and inspect the account only through production routes.
            const held = await holdConnectorAccountFixture(
              {
                orgId: actor.orgId,
                userId: actor.userId,
                connectorId: connectionId,
              },
              context.signal,
            );
            const pending = settleIncludingAbort(request(originalBase));
            const updating = await settleIncludingAbort(
              (async () => {
                await held.waitForBlocked();
                await updateCatalog();
              })(),
            );
            await held.release();
            await pending;
            if (!updating.ok) {
              throw updating.error;
            }
            await expect(pending).resolves.toMatchObject({
              ok: true,
              value: {
                status: 424,
                body: { error: { code: "CONNECTOR_NOT_CONFIGURED" } },
              },
            });
          } else if (refreshGate) {
            const pending = settleIncludingAbort(request(originalBase, true));
            const updating = await settleIncludingAbort(
              (async () => {
                await refreshGate.entered.promise;
                await updateCatalog();
              })(),
            );
            if (!refreshGate.release.settled()) {
              refreshGate.release.resolve();
            }
            await pending;
            if (!updating.ok) {
              throw updating.error;
            }
            await expect(pending).resolves.toMatchObject({
              ok: true,
              value: {
                status: 424,
                body: { error: { code: "CONNECTOR_NOT_CONFIGURED" } },
              },
            });
          } else {
            await updateCatalog();
          }
          if (changedContract === "auth") {
            await installAutomaticMcpCatalog({
              ...catalog,
              endpoint: nextEndpoint,
              firewallAuth: "oauth",
              isolateSource: false,
            });
          }
          if (timing !== "before auth") {
            const retained = await accept(
              accounts.connection({
                headers,
                params: { connectionId },
                query: catalog.target,
              }),
              [200],
            );
            expect(retained.body).toMatchObject({
              connectionStatus: "connected",
              reconnectReason: null,
            });
          }
          const replacement = mockAutomaticMcpOAuthProvider(context, {
            registration: "cimd",
            endpoint: nextEndpoint,
            initialAccessToken: "replacement-endpoint-access-token",
            initialExpiresIn: 3600,
          });
          // The account commits even when notification delivery fails. Keep using
          // the catalog firewall auth without calling runtime sync.
          context.mocks.ably.batchPublish.mockRejectedValue(
            new Error("Wakeup unavailable"),
          );
          await expect(connect(replacement.issuer, connectionId)).resolves.toBe(
            connectionId,
          );
          for (const staleBase of [originalBase, undefined]) {
            const denied = await request(staleBase);
            expect(denied.body).toMatchObject({
              error: { code: "CONNECTOR_NOT_CONFIGURED" },
            });
            expect(JSON.stringify(denied.body)).not.toContain(
              "replacement-endpoint-access-token",
            );
          }
          const valid = await request(nextEndpoint);
          expect(valid.body).toMatchObject({
            headers: {
              Authorization: "Bearer replacement-endpoint-access-token",
            },
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
      context.mocks.ably.batchPublish.mockReset();
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

  it("classifies Automatic temporary refresh failures as upstream without marking reconnect", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", "25");
    onTestFinished(() => {
      mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", undefined);
    });
    const catalog = await installAutomaticMcpCatalog();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      initialExpiresIn: 3600,
      refreshResponse: async (attempt) => {
        if (attempt === 1) {
          await delay(300, { signal: context.signal });
          return HttpResponse.json({
            access_token: "too-late-automatic-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (attempt === 2) {
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
      displayName: "MCP refresh timeout",
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
        const authHeaders = {
          authorization: `Bearer ${claim.sandboxToken}`,
        };
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
        const timedOut = await firewall.requestFirewallAuth(
          authHeaders,
          body,
          [502],
        );
        if (timedOut.status !== 502) {
          throw new Error("Expected the refresh timeout to fail with 502");
        }
        expect(timedOut.body.error).toMatchObject({
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

        mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", undefined);
        const providerFailed = await firewall.requestFirewallAuth(
          authHeaders,
          body,
          [502],
        );
        if (providerFailed.status !== 502) {
          throw new Error("Expected the provider refresh to fail with 502");
        }
        expect(providerFailed.body.error).toMatchObject({
          code: "TOKEN_REFRESH_FAILED",
          failureReason: "upstream_provider",
          connectors: [catalog.slug],
        });
        const afterProviderFailure = await accept(
          accounts.connection({
            headers,
            params: { connectionId },
            query: catalog.target,
          }),
          [200],
        );
        expect(afterProviderFailure.body).toMatchObject({
          connectionStatus: "connected",
          reconnectReason: null,
        });

        const recovered = await firewall.requestFirewallAuth(
          authHeaders,
          body,
          [200],
        );
        if (recovered.status !== 200) {
          throw new Error("Expected the refresh after the timeout to succeed");
        }
        expect(recovered.body.headers.Authorization).toBe(
          "Bearer recovered-automatic-token",
        );
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
  });
});
