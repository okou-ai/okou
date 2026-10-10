import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
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
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
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
      "updates a different verified principal without requiring reconnect",
      "builtin-other-user",
      200,
    ],
  ] as const)("%s", async (_title, refreshedSubject, expectedStatus) => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const catalog = automaticMcpCatalogFixture();
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
    // This provider exposes metadata only at the URL in its current challenge.
    server.use(
      http.get(
        new URL("/.well-known/oauth-protected-resource", provider.endpoint)
          .href,
        () => {
          return new HttpResponse(null, { status: 404 });
        },
      ),
    );
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
    await runs.ensurePersonalSubscriptionModel(actor);
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
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the refreshed MCP identity",
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
    expect(refreshed.body).toMatchObject({
      headers: { Authorization: "Bearer automatic-refreshed-access-token" },
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
      externalId: refreshedSubject,
      externalUsername: "builtin-after-refresh",
      externalEmail: "builtin-preserved@example.test",
      connectionStatus: "connected",
      reconnectReason: null,
    });

    await runs.requestCancelRun(actor, run.runId, [200]);
    // Cancellation callbacks must release lifecycle locks before deletion.
    await flushWaitUntilForTest();
    await connectors.deleteBuiltinConnectorAccount(
      actor,
      catalog.slug,
      connectionId,
    );
    await bdd.deleteAgent(actor, agent.agentId);
  });

  it.each(["cimd", "dcr"] as const)(
    "publishes omitted fields and overlapping refreshes without resurrecting deleted %s accounts",
    async (registration) => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      const catalog = automaticMcpCatalogFixture();
      const startedAt = now();
      mockNow(startedAt);
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        initialExpiresIn: 3600,
        identity: {
          subject: "builtin-refresh-user",
          userInfoUsername: "builtin-before-refresh",
          userInfoEmail: "builtin-preserved@example.test",
        },
        refreshResponse: async (attempt) => {
          if (attempt === 4) {
            await connectors.deleteBuiltinConnectorAccount(
              actor,
              catalog.slug,
              connectionId,
            );
          }
          return HttpResponse.json({
            access_token: `omitted-refresh-token-${attempt}`,
            token_type: "Bearer",
            ...(attempt === 1
              ? {}
              : { expires_in: attempt * 3600, scope: "read write" }),
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
      await runs.ensurePersonalSubscriptionModel(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "MCP omitted refresh fields",
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
      const run = await runs.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "Use persisted Automatic refresh tokens",
      });
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      const builtin = claim.firewalls?.find((entry) => {
        return entry.kind === "builtin" && entry.name === catalog.slug;
      });
      if (builtin?.kind !== "builtin") {
        throw new Error("Expected the builtin Automatic firewall");
      }
      const authHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      const authBody = {
        encryptedSecrets:
          claim.encryptedSecrets ?? firewall.encryptedSecretsBody({}),
        authHeaders: catalog.firewallAuthHeaders,
        matchedFirewall: {
          name: catalog.slug,
          apiId: `${catalog.slug}:0`,
          base: catalog.endpoint,
          connectorSlug: catalog.slug,
          sourceId: connectionId,
          routingVariables: {},
        },
      };
      const refreshed = await firewall.requestFirewallAuth(
        authHeaders,
        { ...authBody, forceRefresh: true },
        [200],
      );
      expect(refreshed.body).toMatchObject({
        headers: { Authorization: "Bearer omitted-refresh-token-1" },
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
        externalId: "builtin-refresh-user",
        externalUsername: "builtin-before-refresh",
        externalEmail: "builtin-preserved@example.test",
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        oauthScopes: ["read", "write"],
      });
      const persisted = await firewall.requestFirewallAuth(
        authHeaders,
        authBody,
        [200],
      );
      expect(persisted.body).toMatchObject({
        headers: { Authorization: "Bearer omitted-refresh-token-1" },
      });

      const overlapping = await Promise.all([
        firewall.requestFirewallAuth(
          authHeaders,
          { ...authBody, forceRefresh: true },
          [200],
        ),
        firewall.requestFirewallAuth(
          authHeaders,
          { ...authBody, forceRefresh: true },
          [200],
        ),
      ]);
      expect(
        overlapping
          .map((response) => {
            if (response.status !== 200) {
              throw new Error("Expected an overlapping refresh to succeed");
            }
            return response.body.headers.Authorization;
          })
          .sort(),
      ).toStrictEqual([
        "Bearer omitted-refresh-token-2",
        "Bearer omitted-refresh-token-3",
      ]);
      const current = await firewall.requestFirewallAuth(
        authHeaders,
        authBody,
        [200],
      );
      if (current.status !== 200) {
        throw new Error(
          "Expected the published credential to remain available",
        );
      }
      const currentAccount = await accept(
        accounts.connection({
          headers,
          params: { connectionId },
          query: catalog.target,
        }),
        [200],
      );
      const publishedAttempt =
        current.body.headers.Authorization === "Bearer omitted-refresh-token-2"
          ? 2
          : 3;
      expect(current.body.headers.Authorization).toBe(
        `Bearer omitted-refresh-token-${publishedAttempt}`,
      );
      expect(currentAccount.body).toMatchObject({
        tokenExpiresAt: new Date(
          startedAt + publishedAttempt * 3_600_000,
        ).toISOString(),
        oauthScopes: ["read", "write"],
        externalId: "builtin-refresh-user",
        connectionStatus: "connected",
      });
      // These are provider-boundary requests, made with the persisted fallback token.
      expect(
        provider.tokenBodies
          .filter((request) => {
            return request.get("grant_type") === "refresh_token";
          })
          .map((request) => {
            return request.get("refresh_token");
          }),
      ).toStrictEqual([
        "automatic-refresh-token",
        "automatic-refresh-token",
        "automatic-refresh-token",
      ]);

      const deletedDuringRefresh = await firewall.requestFirewallAuth(
        authHeaders,
        { ...authBody, forceRefresh: true },
        [502],
      );
      if (deletedDuringRefresh.status !== 502) {
        throw new Error("Expected refresh of the deleted account to fail");
      }
      expect(deletedDuringRefresh.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
        connectors: [catalog.slug],
      });
      await accept(
        accounts.connection({
          headers,
          params: { connectionId },
          query: catalog.target,
        }),
        [404],
      );

      await runs.requestCancelRun(actor, run.runId, [200]);
      // Cancellation callbacks must release lifecycle locks before deletion.
      await flushWaitUntilForTest();
      await bdd.deleteAgent(actor, agent.agentId);
    },
  );

  it.each([
    "timeout",
    "provider failure",
    "recovery",
    "DCR rejection",
    "DCR expiry",
  ] as const)("classifies Automatic refresh %s", async (outcomeKind) => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    if (outcomeKind === "timeout") {
      mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", "25");
    }
    onTestFinished(() => {
      mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", undefined);
    });
    const catalog = automaticMcpCatalogFixture();
    const refreshAborted = createDeferredPromise<void>(context.signal);
    const dcr = outcomeKind === "DCR rejection" || outcomeKind === "DCR expiry";
    const startedAt = now();
    if (outcomeKind === "DCR expiry") {
      mockNow(startedAt);
    }
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: dcr ? "dcr" : "cimd",
      ...(outcomeKind === "DCR expiry"
        ? {
            dcrClientIdIssuedAt: startedAt - 1000,
            dcrClientSecretExpiresAt: startedAt + 60_000,
          }
        : {}),
      initialExpiresIn: 3600,
      refreshResponse: async (attempt, signal) => {
        if (outcomeKind === "DCR rejection") {
          return HttpResponse.json(
            { error: "invalid_client" },
            { status: 400 },
          );
        }
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
    await runs.ensurePersonalSubscriptionModel(actor);
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
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the selected MCP account",
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
        if (outcomeKind === "DCR expiry") {
          mockNow(startedAt + 61_000);
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
          failureReason: dcr ? "reconnect_required" : "upstream_provider",
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
          connectionStatus: dcr ? "reconnect-required" : "connected",
          reconnectReason: dcr ? "authorization_expired_or_revoked" : null,
        });
      })(),
    );
    await runs.requestCancelRun(actor, run.runId, [200]);
    // Cancellation callbacks must release lifecycle locks before deletion.
    await flushWaitUntilForTest();
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
