import { randomUUID } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

async function setupCustomOAuthFirewall(
  mode: "configured" | "automatic",
  refreshResponse: (attempt: number) => Response | Promise<Response>,
) {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  const provider =
    mode === "automatic"
      ? mockAutomaticMcpOAuthProvider(context, {
          registration: "cimd",
          initialExpiresIn: 3600,
          refreshResponse,
        })
      : mockCustomConnectorOAuth2Provider(context, {
          initialExpiresIn: 3600,
          refreshResponse,
        });
  const bdd = createBddApi(context);
  const fw = createFirewallApi(context);
  const runs = createRunsApi(context);
  const connectors = createConnectorBddApi(context);
  const actor = bdd.user({ orgRole: "org:admin" });
  if (mode === "automatic") {
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
  }
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  await fw.provisionRunReadyOrg(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Custom OAuth refresh agent",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "resolve custom OAuth firewall auth",
    modelProvider: "anthropic-api-key",
  });
  const headers = fw.sandboxHeaders(actor, run.runId);
  const connector = await connectors.createCustomConnector(
    actor,
    "endpoint" in provider
      ? {
          kind: "mcp",
          displayName: "Automatic OAuth refresh",
          endpoint: provider.endpoint,
          transport: "streamable-http",
          fields: [],
          headerInjections: [],
          queryInjections: [],
          authMode: "automatic",
        }
      : {
          displayName: "Custom OAuth refresh",
          prefixTemplates: [`https://${randomUUID()}.example.test/v1/`],
          fields: [],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{oauth.access_token}}",
            },
          ],
          queryInjections: [],
          authMode: "oauth",
          oauthConfig: {
            providerAdapter: "standard",
            clientId: "custom-refresh-client",
            clientSecret: "custom-refresh-secret",
            authorizationUrl: provider.authorizationUrl,
            tokenUrl: provider.tokenUrl,
            tokenEndpointAuthMethod: "client_secret_post",
            pkceMethod: "none",
            scopes: ["read"],
            authorizationParams: {},
          },
        },
  );
  async function connect(mutation: ConnectorAccountMutationIntent) {
    const previous = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    const url = await connectors.startCustomConnectorOAuth2(
      actor,
      connector.id,
      agent.agentId,
      mutation,
    );
    const state = new URL(url).searchParams.get("state");
    if (!state) {
      throw new Error("Expected custom OAuth authorization state");
    }
    const callback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: randomUUID(),
        state,
        ...("issuer" in provider ? { iss: provider.issuer } : {}),
      });
    expect(callback.body.status).toBe("success");
    const accounts = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    const account = accounts.find((candidate) => {
      return mutation.intent === "reconnect"
        ? candidate.id === mutation.connectionId
        : !previous.some((old) => {
            return old.id === candidate.id;
          });
    });
    if (!account) {
      throw new Error("Expected authorized custom OAuth account");
    }
    return account;
  }
  function request(connectionId: string, forceRefresh: boolean) {
    const internalName = `custom_connector_${connector.id.replaceAll("-", "")}`;
    const secretKey = `CUSTOM_${connector.id.replaceAll("-", "")}_S___OAUTH_ACCESS_TOKEN`;
    return fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: { Authorization: `Bearer ${secretTemplate(secretKey)}` },
        matchedFirewall: {
          name: internalName,
          apiId: `${internalName}:0`,
          customConnectorId: connector.id,
          sourceId: connectionId,
          routingVariables: {},
        },
        forceRefresh,
      },
      [200, 502],
    );
  }
  const account = await connect({ intent: "add", displayName: "First" });
  return { actor, account, connector, connectors, provider, connect, request };
}

describe.each(["configured", "automatic"] as const)(
  "Custom %s OAuth quiet refresh recovery",
  (mode) => {
    it.each([
      { subtype: undefined, reason: "authorization_expired_or_revoked" },
      { subtype: "invalid_rapt", reason: "authorization_expired_or_revoked" },
    ])(
      "retries invalid_grant ($subtype) quietly and recovers the exact account",
      async ({ subtype, reason }) => {
        const started = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        onTestFinished(() => {
          if (!release.settled()) {
            release.resolve(undefined);
          }
        });
        let refreshCalls = 0;
        const custom = await setupCustomOAuthFirewall(mode, async () => {
          refreshCalls += 1;
          if (!started.settled()) {
            started.resolve(undefined);
          }
          await release.promise;
          return HttpResponse.json(
            {
              error: "invalid_grant",
              ...(subtype ? { error_subtype: subtype } : {}),
            },
            { status: 400 },
          );
        });
        const sibling = await custom.connect({
          intent: "add",
          displayName: "Second",
        });
        context.mocks.sentry.captureException.mockClear();
        const first = custom.request(custom.account.id, true);
        await started.promise;
        const concurrent = custom.request(custom.account.id, true);
        release.resolve(undefined);
        const responses = await Promise.all([first, concurrent]);

        mocks.clerk.session(custom.actor.userId, custom.actor.orgId);
        await accept(
          setupApp({ context, routes: connectorAccountRoutes })(
            connectorAccountsContract,
          ).setDefault({
            headers: { authorization: "Bearer clerk-session" },
            params: { connectionId: sibling.id },
            body: {
              target: {
                kind: "custom",
                customConnectorId: custom.connector.id,
              },
            },
          }),
          [200],
        );
        responses.push(await custom.request(custom.account.id, false));
        responses.push(await custom.request(custom.account.id, true));
        for (const response of responses) {
          expect(response.status).toBe(502);
          expect(response.body).toMatchObject({
            error: {
              code: "TOKEN_REFRESH_FAILED",
              failureReason: "reconnect_required",
            },
          });
        }
        expect(refreshCalls).toBe(4);
        await expect(
          custom.connectors.listCustomConnectorAccounts(
            custom.actor,
            custom.connector.id,
          ),
        ).resolves.toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: custom.account.id,
              connectionStatus: "reconnect-required",
              reconnectReason: reason,
            }),
            expect.objectContaining({
              id: sibling.id,
              connectionStatus: "connected",
              reconnectReason: null,
            }),
          ]),
        );
        const siblingAuth = await custom.request(sibling.id, false);
        expect(siblingAuth.status).toBe(200);
        expect(refreshCalls).toBe(4);
        expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();

        const replacement =
          mode === "automatic"
            ? mockAutomaticMcpOAuthProvider(context, {
                registration: "cimd",
                initialExpiresIn: 3600,
                initialRefreshToken: "replacement-custom-refresh",
              })
            : mockCustomConnectorOAuth2Provider(context, {
                initialExpiresIn: 3600,
                initialRefreshToken: "replacement-custom-refresh",
              });
        const retried = await custom.request(custom.account.id, false);
        expect(retried.status).toBe(200);
        expect(retried.body).toMatchObject({
          headers: {
            Authorization:
              mode === "automatic"
                ? "Bearer automatic-refreshed-access-token"
                : "Bearer custom-oauth-refreshed-access-token",
          },
        });
        expect(replacement.tokenBodies.at(-1)?.get("refresh_token")).toBe(
          mode === "automatic"
            ? "automatic-refresh-token"
            : "custom-oauth-refresh-token",
        );
        await expect(
          custom.connectors.listCustomConnectorAccounts(
            custom.actor,
            custom.connector.id,
          ),
        ).resolves.toContainEqual(
          expect.objectContaining({
            id: custom.account.id,
            connectionStatus: "connected",
            reconnectReason: null,
          }),
        );

        const reconnected = await custom.connect({
          intent: "reconnect",
          connectionId: custom.account.id,
        });
        expect(reconnected).toMatchObject({
          id: custom.account.id,
          connectionStatus: "connected",
          reconnectReason: null,
        });
        const recovered = await custom.request(custom.account.id, true);
        expect(recovered.status).toBe(200);
        expect(recovered.body).toMatchObject({
          headers: {
            Authorization:
              mode === "automatic"
                ? "Bearer automatic-refreshed-access-token"
                : "Bearer custom-oauth-refreshed-access-token",
          },
        });
        expect(replacement.tokenBodies.at(-1)?.get("refresh_token")).toBe(
          "replacement-custom-refresh",
        );
      },
    );

    it.each([
      {
        name: "provider outage",
        status: 503,
        error: "server_error",
      },
      {
        name: "rate limit",
        status: 429,
        error: "temporarily_unavailable",
      },
    ])("keeps $name observable and recoverable", async ({ status, error }) => {
      const custom = await setupCustomOAuthFirewall(mode, (attempt) => {
        return attempt <= 2
          ? HttpResponse.json({ error }, { status })
          : HttpResponse.json({
              access_token: "custom-recovered",
              token_type: "Bearer",
              expires_in: 3600,
            });
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failed = await custom.request(custom.account.id, true);
        expect(failed.status).toBe(502);
        expect(failed.body).toMatchObject({
          error: {
            code: "TOKEN_REFRESH_FAILED",
            failureReason: "upstream_provider",
          },
        });
      }
      expect(custom.provider.tokenBodies).toHaveLength(3);
      await expect(
        custom.connectors.listCustomConnectorAccounts(
          custom.actor,
          custom.connector.id,
        ),
      ).resolves.toContainEqual(
        expect.objectContaining({
          id: custom.account.id,
          connectionStatus: "connected",
          reconnectReason: null,
        }),
      );
      const recovered = await custom.request(custom.account.id, true);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({
        headers: { Authorization: "Bearer custom-recovered" },
      });
    });
  },
);
