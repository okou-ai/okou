import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import type { CustomConnectorNetworkIntent } from "@okouai/api-contracts/validators/custom-connector-network";

import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { describe, expect, it, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
  mockAutomaticMcpOAuthProvider,
  type OAuthIdentityFixtureOptions,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createPublicFirewallFixture,
  type PublicFirewallFixture,
} from "./helpers/public-firewall-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

async function setupCustomOAuthFirewall(
  mode: "configured" | "automatic",
  refreshResponse:
    ((attempt: number) => Response | Promise<Response>) | undefined,
  identity: {
    readonly initial?: OAuthIdentityFixtureOptions;
    readonly refresh?: OAuthIdentityFixtureOptions;
  },
  publicFixture: PublicFirewallFixture,
  automaticOptions: {
    readonly registration?: "cimd" | "dcr";
    readonly dcrClientSecretExpiresAt?: number;
    readonly protectedIssuer?: boolean;
  } = {},
) {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  const endpoint = `https://${randomUUID()}.example.test/mcp/`;
  const provider =
    mode === "automatic"
      ? mockAutomaticMcpOAuthProvider(context, {
          registration: "cimd",
          ...automaticOptions,
          ...(automaticOptions.protectedIssuer
            ? { endpoint, tokenEndpoint: `${endpoint}token` }
            : {}),
          initialExpiresIn: 3600,
          ...(refreshResponse ? { refreshResponse } : {}),
          ...(identity.initial ? { identity: identity.initial } : {}),
          ...(identity.refresh ? { refreshIdentity: identity.refresh } : {}),
        })
      : mockCustomConnectorOAuth2Provider(context, {
          initialExpiresIn: 3600,
          ...(refreshResponse ? { refreshResponse } : {}),
          ...(identity.initial ? { identity: identity.initial } : {}),
          ...(identity.refresh ? { refreshIdentity: identity.refresh } : {}),
          identityAudience: "custom-refresh-client",
        });
  const bdd = createBddApi(context);
  const fw = createFirewallApi(context);
  const runs = createRunsApi(context);
  const connectors = createConnectorBddApi(context);
  const actor = publicFixture.actor;
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = await runs.configureRunnerGroup();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  await publicFixture.fund();
  await runs.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Custom OAuth refresh agent",
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "resolve custom OAuth firewall auth",
  });
  publicFixture.registerRun(run.runId);
  await runs.heartbeatRunner(runnerGroup);
  const execution = await runs.executionInput(run.runId);
  publicFixture.registerExecution(run.runId, execution.sandboxToken);
  const headers = { authorization: `Bearer ${execution.sandboxToken}` };
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
          prefixTemplates: [
            automaticOptions.protectedIssuer
              ? `${new URL(provider.tokenUrl).origin}/`
              : `https://${randomUUID()}.example.test/v1/`,
          ],
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
  const ownedAccountIds = publicFixture.registerCustomConnector(connector.id);
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
    ownedAccountIds.add(account.id);
    return account;
  }
  function request(
    connectionId: string,
    forceRefresh: boolean,
    networkAdmission = false,
    intent: CustomConnectorNetworkIntent = { kind: "direct" },
  ) {
    const internalName = `custom_connector_${connector.id.replaceAll("-", "")}`;
    const secretKey = `CUSTOM_${connector.id.replaceAll("-", "")}_S___OAUTH_ACCESS_TOKEN`;
    return fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: networkAdmission
          ? {}
          : { Authorization: `Bearer ${secretTemplate(secretKey)}` },
        matchedFirewall: {
          name: internalName,
          apiId: `${internalName}:0`,
          customConnectorId: connector.id,
          sourceId: connectionId,
          routingVariables: {},
        },
        forceRefresh,
        ...(intent.kind === "cloudflare_access"
          ? { networkIntent: intent }
          : {}),
        ...(networkAdmission
          ? {
              networkAdmission: true as const,
              networkRequest: {
                method: "GET",
                url:
                  connector.kind === "mcp"
                    ? connector.endpoint
                    : (connector.prefixTemplates[0] ?? ""),
                intent,
              },
            }
          : {}),
      },
      [200, 400, 403, 502],
    );
  }
  const account = await connect({ intent: "add", displayName: "First" });
  return {
    actor,
    account,
    connector,
    connectors,
    provider,
    connect,
    request,
    agentId: agent.agentId,
    runId: run.runId,
    runnerGroup,
    headers,
  };
}

async function bindCustomOAuthNetwork(
  custom: Awaited<ReturnType<typeof setupCustomOAuthFirewall>>,
) {
  await custom.connectors.updateFeatureSwitches(custom.actor, {
    [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
  });
  mocks.clerk.session(custom.actor.userId, custom.actor.orgId, "org:admin");
  const api = setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
  const config = (
    await accept(
      api.create({
        headers: { authorization: "Bearer clerk-session" },
        query: { view: "scoped" },
        body: {
          id: randomUUID(),
          scope: "organization",
          name: "Refresh network",
          credentials: {
            clientId: "network-client",
            clientSecret: "network-secret",
          },
        },
      }),
      [201],
    )
  ).body;
  const connector = custom.connector;
  await custom.connectors.updateCustomConnector(custom.actor, connector.id, {
    displayName: connector.displayName,
    fields: connector.fields,
    headerInjections: connector.headerInjections,
    queryInjections: connector.queryInjections,
    storageVersion: connector.storageVersion,
    ...(connector.kind === "mcp"
      ? {
          kind: "mcp",
          authMode: "automatic",
          endpoint: connector.endpoint,
          transport: connector.transport,
        }
      : { kind: "http", prefixTemplates: connector.prefixTemplates }),
    networkBinding: { type: "cloudflare_access", configId: config.id },
  });
  return {
    api,
    config,
    intent: {
      kind: "cloudflare_access" as const,
      configId: config.id,
      generation: 1,
    },
  };
}

test.each([
  { registration: "cimd", failure: "network-change" },
  { registration: "dcr", failure: "network-change" },
  { registration: "cimd", failure: "unattributed-authority" },
  { registration: "dcr", failure: "unattributed-authority" },
] as const)(
  "retains $registration authority across $failure during refresh discovery",
  async ({ registration, failure }) => {
    const fixture = createPublicFirewallFixture(context, {
      orgRole: "org:admin",
    });
    await fixture.run(async () => {
      context.mocks.dns.resolve4.mockResolvedValue(["8.8.8.8"]);
      context.mocks.dns.resolve6.mockResolvedValue([]);
      const custom = await setupCustomOAuthFirewall(
        "automatic",
        undefined,
        {},
        fixture,
        {
          registration,
          protectedIssuer: true,
        },
      );
      if (!("issuer" in custom.provider)) {
        throw new Error("Expected an automatic MCP provider");
      }
      const provider = custom.provider;
      const { api, config, intent } = await bindCustomOAuthNetwork(custom);
      if (failure === "network-change") {
        server.use(
          http.get(
            new URL("/oauth-resource", provider.endpoint).href,
            async () => {
              await accept(
                api.update({
                  headers: { authorization: "Bearer clerk-session" },
                  query: { view: "scoped" },
                  params: { configId: config.id },
                  body: {
                    expectedRevision: config.revision,
                    credentials: {
                      clientId: "rotated-client",
                      clientSecret: "rotated-secret",
                    },
                  },
                }),
                [200],
              );
              return HttpResponse.json({
                resource: provider.endpoint,
                authorization_servers: [provider.issuer],
              });
            },
            { once: true },
          ),
        );
      } else {
        const alternative = mockAutomaticMcpOAuthProvider(context, {
          registration,
          endpoint: `https://${randomUUID()}.example.test/server`,
          issuer: `https://${randomUUID()}.example.test/`,
        });
        provider.advertiseAuthorizationServers([alternative.issuer]);
      }
      const failed = await custom.request(
        custom.account.id,
        true,
        false,
        intent,
      );
      expect(failed).toMatchObject({
        status: 502,
        body: {
          error: {
            code: "TOKEN_REFRESH_FAILED",
            failureReason: "upstream_provider",
          },
        },
      });
      expect(provider.tokenBodies).toHaveLength(1);
      await expect(
        custom.connectors.listCustomConnectorAccounts(
          custom.actor,
          custom.connector.id,
        ),
      ).resolves.toMatchObject([
        {
          id: custom.account.id,
          connectionStatus: "connected",
          reconnectReason: null,
        },
      ]);
      provider.advertiseAuthorizationServers([provider.issuer]);
      const recovered = await custom.request(
        custom.account.id,
        true,
        false,
        intent,
      );
      expect(recovered.status).toBe(200);
      expect(provider.tokenBodies).toHaveLength(2);
      expect(provider.registrationBodies).toHaveLength(
        registration === "dcr" ? 1 : 0,
      );
      expect(provider.tokenHeaders.at(-1)?.get("CF-Access-Client-Secret")).toBe(
        failure === "network-change" ? "rotated-secret" : "network-secret",
      );
    });
  },
);

describe.each([
  { mode: "configured", registration: "cimd" },
  { mode: "automatic", registration: "cimd" },
  { mode: "automatic", registration: "dcr" },
] as const)(
  "Access-protected $mode $registration refresh",
  ({ mode, registration }) => {
    it.each([
      { status: 401, challenge: undefined, oauthError: undefined },
      { status: 403, challenge: undefined, oauthError: undefined },
      { status: 401, challenge: "Bearer", oauthError: undefined },
      {
        status: 401,
        challenge: 'Digest realm="gateway", Bearer',
        oauthError: undefined,
      },
      { status: 400, challenge: undefined, oauthError: "invalid_grant" },
      { status: 404, challenge: undefined, oauthError: "invalid_grant" },
      { status: 401, challenge: "Basic", oauthError: "invalid_client" },
      { status: 503, challenge: undefined, oauthError: undefined },
    ])(
      "preserves the account and registration on an unattributed $status ($challenge, $oauthError)",
      async ({ status, challenge, oauthError }) => {
        const fixture = createPublicFirewallFixture(context, {
          orgRole: "org:admin",
        });
        await fixture.run(async () => {
          context.mocks.dns.resolve4.mockResolvedValue(["8.8.8.8"]);
          context.mocks.dns.resolve6.mockResolvedValue([]);
          let refreshCalls = 0;
          const custom = await setupCustomOAuthFirewall(
            mode,
            () => {
              refreshCalls += 1;
              if (refreshCalls > 1) {
                return HttpResponse.json({
                  access_token: "explicitly-recovered",
                  token_type: "Bearer",
                  expires_in: 3600,
                });
              }
              const init = {
                status,
                ...(challenge
                  ? { headers: { "www-authenticate": challenge } }
                  : {}),
              };
              return oauthError
                ? HttpResponse.json({ error: oauthError }, init)
                : new HttpResponse("Request rejected", init);
            },
            {},
            fixture,
            { registration, protectedIssuer: true },
          );
          const connector = custom.connector;
          const { intent } = await bindCustomOAuthNetwork(custom);
          const failed = await custom.request(
            custom.account.id,
            true,
            false,
            intent,
          );
          expect(failed).toMatchObject({
            status: 502,
            body: {
              error: {
                code: "TOKEN_REFRESH_FAILED",
                failureReason: "upstream_provider",
              },
            },
          });
          expect(refreshCalls).toBe(1);
          await expect(
            custom.connectors.listCustomConnectorAccounts(
              custom.actor,
              connector.id,
            ),
          ).resolves.toMatchObject([
            {
              id: custom.account.id,
              connectionStatus: "connected",
              reconnectReason: null,
            },
          ]);
          if ("tokenHeaders" in custom.provider) {
            expect(
              custom.provider.tokenHeaders
                .at(-1)
                ?.get("CF-Access-Client-Secret"),
            ).toBe("network-secret");
          }
          const retained = await custom.request(
            custom.account.id,
            false,
            false,
            intent,
          );
          expect(retained.status).toBe(200);
          expect(refreshCalls).toBe(1);
          const recovered = await custom.request(
            custom.account.id,
            true,
            false,
            intent,
          );
          expect(recovered).toMatchObject({
            status: 200,
            body: { headers: { Authorization: "Bearer explicitly-recovered" } },
          });
          expect(refreshCalls).toBe(2);
          if ("registrationBodies" in custom.provider) {
            expect(custom.provider.registrationBodies).toHaveLength(
              registration === "dcr" ? 1 : 0,
            );
          }
          expect(JSON.stringify(failed.body)).not.toContain("network-secret");
        });
      },
    );
  },
);

test("custom network admission is explicitly opted in and leaves installed Runner responses unchanged", async () => {
  const fixture = createPublicFirewallFixture(context, {
    orgRole: "org:admin",
  });
  await fixture.run(async () => {
    const custom = await setupCustomOAuthFirewall(
      "configured",
      undefined,
      {},
      fixture,
    );
    const legacy = await custom.request(custom.account.id, false);
    expect(legacy.status).toBe(200);
    expect(legacy.body).not.toHaveProperty("networkAdmission");
    await custom.connectors.updateFeatureSwitches(custom.actor, {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
    });
    const installedRunner = await custom.request(custom.account.id, false);
    expect(installedRunner.status).toBe(legacy.status);
    expect(installedRunner.body).toStrictEqual(legacy.body);
    const admitted = await custom.request(custom.account.id, false, true);
    expect(admitted.status).toBe(200);
    expect(admitted.body).toMatchObject({
      expiresAt: null,
      networkAdmission: { kind: "direct" },
    });
  });
});

test("run network admission uses current bindings and rotation independently of application OAuth", async () => {
  const fixture = createPublicFirewallFixture(context, {
    orgRole: "org:admin",
  });
  await fixture.run(async () => {
    mockEnv("ABLY_API_KEY", "test.key:secret");
    const custom = await setupCustomOAuthFirewall(
      "configured",
      undefined,
      {},
      fixture,
    );
    await custom.connectors.updateFeatureSwitches(custom.actor, {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
    });
    mocks.clerk.session(custom.actor.userId, custom.actor.orgId, "org:admin");
    const api = setupApp({ context, routes: cloudflareAccessRoutes })(
      cloudflareAccessContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const config = (
      await accept(
        api.create({
          headers,
          query: { view: "scoped" },
          body: {
            id: randomUUID(),
            scope: "organization",
            name: "Run network",
            credentials: { clientId: "first-id", clientSecret: "first-secret" },
          },
        }),
        [201],
      )
    ).body;
    const connector = custom.connector;
    const definition = {
      displayName: connector.displayName,
      fields: connector.fields,
      headerInjections: connector.headerInjections,
      queryInjections: connector.queryInjections,
      storageVersion: connector.storageVersion,
      ...(connector.kind === "mcp"
        ? {
            kind: "mcp" as const,
            endpoint: connector.endpoint,
            transport: connector.transport,
          }
        : {
            kind: "http" as const,
            prefixTemplates: connector.prefixTemplates,
          }),
    };
    await custom.connectors.updateCustomConnector(custom.actor, connector.id, {
      ...definition,
      networkBinding: { type: "cloudflare_access", configId: config.id },
    });
    expect((await custom.request(custom.account.id, false, true)).status).toBe(
      403,
    );
    const intent = {
      kind: "cloudflare_access" as const,
      configId: config.id,
      generation: 1,
    };
    const admitted = await custom.request(
      custom.account.id,
      false,
      true,
      intent,
    );
    expect(admitted).toMatchObject({
      status: 200,
      body: {
        headers: {},
        expiresAt: null,
        networkAdmission: {
          ...intent,
          generation: 1,
          headers: {
            "CF-Access-Client-Id": "first-id",
            "CF-Access-Client-Secret": "first-secret",
          },
        },
      },
    });
    context.mocks.ably.batchPublish.mockClear();
    await accept(
      api.update({
        headers,
        params: { configId: config.id },
        query: { view: "scoped" },
        body: {
          expectedRevision: config.revision,
          credentials: { clientId: "next-id", clientSecret: "next-secret" },
        },
      }),
      [200],
    );
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledExactlyOnceWith({
      channels: [`runner-group:${custom.runnerGroup}`],
      messages: [
        {
          name: "connector-runtime-sync",
          data: JSON.stringify({
            runId: custom.runId,
            target: { kind: "custom", customConnectorId: connector.id },
          }),
          encoding: "json",
        },
      ],
    });
    const [synchronized] = await createRunsApi(context).syncConnectorRuntime(
      custom.runId,
      {
        targets: [
          {
            kind: "custom",
            customConnectorId: connector.id,
            sourceId: custom.account.id,
            baseUrlVars: {},
          },
        ],
      },
    );
    expect(synchronized).toMatchObject({
      state: "available",
      firewall: {
        firewall: {
          apis: [
            expect.objectContaining({
              networkIntent: {
                kind: "cloudflare_access",
                configId: config.id,
                generation: 2,
              },
            }),
          ],
        },
      },
    });
    const rotated = await custom.request(
      custom.account.id,
      false,
      true,
      intent,
    );
    expect(rotated).toMatchObject({
      status: 200,
      body: {
        networkAdmission: {
          generation: 2,
          headers: {
            "CF-Access-Client-Id": "next-id",
            "CF-Access-Client-Secret": "next-secret",
          },
        },
      },
    });
    expect(JSON.stringify(rotated.body)).not.toContain("first-secret");
    await custom.connectors.requestUpdateAgentCustomConnectors(
      custom.actor,
      custom.agentId,
      [connector.id],
      [200],
      "remove",
    );
    expect(
      (await custom.request(custom.account.id, false, true, intent)).status,
    ).toBe(403);
    await custom.connectors.requestUpdateAgentCustomConnectors(
      custom.actor,
      custom.agentId,
      [connector.id],
      [200],
      "add",
    );
    const accountless = await custom.connectors.createCustomConnector(
      custom.actor,
      {
        kind: "http",
        displayName: "No application account",
        prefixTemplates: ["https://noauth.example.test/"],
        authMode: "none",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        networkBinding: { type: "cloudflare_access", configId: config.id },
      },
    );
    fixture.registerCustomConnector(accountless.id);
    const accountlessName = `custom_connector_${accountless.id.replaceAll("-", "")}`;
    const networkBody = {
      authHeaders: {},
      networkAdmission: true as const,
      networkRequest: {
        method: "GET",
        url: "https://noauth.example.test/items",
        intent,
      },
      matchedFirewall: {
        name: accountlessName,
        apiId: `${accountlessName}:0`,
        customConnectorId: accountless.id,
        routingVariables: {},
      },
    };
    const firewall = createFirewallApi(context);
    expect(
      (await firewall.requestFirewallAuth(custom.headers, networkBody, [403]))
        .status,
    ).toBe(403);
    await custom.connectors.requestUpdateAgentCustomConnectors(
      custom.actor,
      custom.agentId,
      [accountless.id],
      [200],
      "add",
    );
    await expect(
      firewall.requestFirewallAuth(custom.headers, networkBody, [200]),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        headers: {},
        networkAdmission: {
          generation: 2,
          headers: { "CF-Access-Client-Secret": "next-secret" },
        },
      },
    });
    expect(
      (
        await firewall.requestFirewallAuth(
          custom.headers,
          {
            ...networkBody,
            matchedFirewall: {
              ...networkBody.matchedFirewall,
              sourceId: custom.account.id,
            },
          },
          [403],
        )
      ).status,
    ).toBe(403);
    await custom.connectors.updateCustomConnector(custom.actor, connector.id, {
      ...definition,
      networkBinding: null,
    });
    expect(
      (await custom.request(custom.account.id, false, true, intent)).status,
    ).toBe(403);
    expect((await custom.request(custom.account.id, false, true)).status).toBe(
      200,
    );
    await expect(
      custom.connectors.listCustomConnectorAccounts(custom.actor, connector.id),
    ).resolves.toMatchObject([
      { id: custom.account.id, connectionStatus: "connected" },
    ]);
  });
});

describe("Custom Automatic DCR credential retirement", () => {
  it.each(["invalid_client", "expired registration"] as const)(
    "requires all linked accounts to reconnect after %s and recovers one account",
    async (trigger) => {
      const startedAt = now();
      mockNow(startedAt);
      const fixture = createPublicFirewallFixture(context, {
        orgRole: "org:admin",
      });
      await fixture.run(async () => {
        const custom = await setupCustomOAuthFirewall(
          "automatic",
          () => {
            return HttpResponse.json(
              { error: "invalid_client" },
              { status: 400 },
            );
          },
          {},
          fixture,
          {
            registration: "dcr",
            ...(trigger === "expired registration"
              ? {
                  dcrClientSecretExpiresAt: Math.floor(
                    (startedAt + 60_000) / 1000,
                  ),
                }
              : {}),
          },
        );
        const sibling = await custom.connect({
          intent: "add",
          displayName: "Second",
        });
        if (trigger === "expired registration") {
          mockNow(startedAt + 120_000);
        }
        for (const account of [custom.account, sibling]) {
          const failed = await custom.request(account.id, true);
          expect(failed.status).toBe(502);
          expect(failed.body).toMatchObject({
            error: {
              code: "TOKEN_REFRESH_FAILED",
              failureReason: "reconnect_required",
            },
          });
        }
        await expect(
          custom.connectors.listCustomConnectorAccounts(
            custom.actor,
            custom.connector.id,
          ),
        ).resolves.toMatchObject([
          {
            connectionStatus: "reconnect-required",
            reconnectReason: "authorization_expired_or_revoked",
          },
          {
            connectionStatus: "reconnect-required",
            reconnectReason: "authorization_expired_or_revoked",
          },
        ]);
        const replacement = mockAutomaticMcpOAuthProvider(context, {
          registration: "dcr",
        });
        await custom.connect({
          intent: "reconnect",
          connectionId: custom.account.id,
        });
        expect(replacement.registrationBodies).toHaveLength(1);
        const recovered = await custom.request(custom.account.id, true);
        expect(recovered.status).toBe(200);
        expect(recovered.body).toMatchObject({
          headers: { Authorization: "Bearer automatic-refreshed-access-token" },
        });
        await expect(
          custom.connectors.listCustomConnectorAccounts(
            custom.actor,
            custom.connector.id,
          ),
        ).resolves.toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: custom.account.id,
              connectionStatus: "connected",
              reconnectReason: null,
            }),
            expect.objectContaining({
              id: sibling.id,
              connectionStatus: "reconnect-required",
              reconnectReason: "authorization_expired_or_revoked",
            }),
          ]),
        );
      });
    },
  );
});

describe.each(["configured", "automatic"] as const)(
  "Custom %s OAuth quiet refresh recovery",
  (mode) => {
    it.each([
      { subtype: undefined, reason: "authorization_expired_or_revoked" },
      { subtype: "invalid_rapt", reason: "authorization_expired_or_revoked" },
    ])(
      "retries invalid_grant ($subtype) and recovers the exact account",
      async ({ subtype, reason }) => {
        const publicFixture = createPublicFirewallFixture(context, {
          orgRole: "org:admin",
        });
        await publicFixture.run(async () => {
          let refreshCalls = 0;
          const custom = await setupCustomOAuthFirewall(
            mode,
            () => {
              refreshCalls += 1;
              return HttpResponse.json(
                {
                  error: "invalid_grant",
                  ...(subtype ? { error_subtype: subtype } : {}),
                },
                { status: 400 },
              );
            },
            {},
            publicFixture,
          );
          const sibling = await custom.connect({
            intent: "add",
            displayName: "Second",
          });
          const responses = [await custom.request(custom.account.id, true)];

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
          expect(refreshCalls).toBe(3);
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
          expect(refreshCalls).toBe(3);

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
        });
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
      const publicFixture = createPublicFirewallFixture(context, {
        orgRole: "org:admin",
      });
      await publicFixture.run(async () => {
        const custom = await setupCustomOAuthFirewall(
          mode,
          (attempt) => {
            return attempt <= 2
              ? HttpResponse.json({ error }, { status })
              : HttpResponse.json({
                  access_token: "custom-recovered",
                  token_type: "Bearer",
                  expires_in: 3600,
                });
          },
          {},
          publicFixture,
        );
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
    });
  },
);

describe.each(["configured", "automatic"] as const)(
  "Custom %s OAuth identity refresh",
  (mode) => {
    it("populates a previously unnamed account from verified refresh identity", async () => {
      const publicFixture = createPublicFirewallFixture(context, {
        orgRole: "org:admin",
      });
      await publicFixture.run(async () => {
        const custom = await setupCustomOAuthFirewall(
          mode,
          undefined,
          {
            refresh: {
              subject: `${mode}-refresh-user`,
              userInfoUsername: `${mode}-refresh-name`,
              userInfoEmail: `${mode}-refresh@example.test`,
            },
          },
          publicFixture,
        );

        const refreshed = await custom.request(custom.account.id, true);
        expect(refreshed.status).toBe(200);
        expect(refreshed.body).toMatchObject({
          headers: {
            Authorization:
              mode === "automatic"
                ? "Bearer automatic-refreshed-access-token"
                : "Bearer custom-oauth-refreshed-access-token",
          },
        });
        await expect(
          custom.connectors.listCustomConnectorAccounts(
            custom.actor,
            custom.connector.id,
          ),
        ).resolves.toContainEqual(
          expect.objectContaining({
            id: custom.account.id,
            externalId: `${mode}-refresh-user`,
            externalUsername: `${mode}-refresh-name`,
            externalEmail: `${mode}-refresh@example.test`,
            connectionStatus: "connected",
            reconnectReason: null,
          }),
        );
      });
    });

    it("updates verified principal metadata during refresh without requiring reconnect", async () => {
      const publicFixture = createPublicFirewallFixture(context, {
        orgRole: "org:admin",
      });
      await publicFixture.run(async () => {
        const custom = await setupCustomOAuthFirewall(
          mode,
          undefined,
          {
            initial: {
              subject: `${mode}-original-user`,
              userInfoUsername: `${mode}-original-name`,
              userInfoEmail: `${mode}-original@example.test`,
            },
            refresh: {
              subject: `${mode}-other-user`,
              userInfoUsername: `${mode}-other-name`,
              userInfoEmail: `${mode}-other@example.test`,
            },
          },
          publicFixture,
        );

        const refreshed = await custom.request(custom.account.id, true);
        expect(refreshed.status).toBe(200);
        expect(refreshed.body).toMatchObject({
          headers: {
            Authorization:
              mode === "automatic"
                ? "Bearer automatic-refreshed-access-token"
                : "Bearer custom-oauth-refreshed-access-token",
          },
        });
        await expect(
          custom.connectors.listCustomConnectorAccounts(
            custom.actor,
            custom.connector.id,
          ),
        ).resolves.toContainEqual(
          expect.objectContaining({
            id: custom.account.id,
            externalId: `${mode}-other-user`,
            externalUsername: `${mode}-other-name`,
            externalEmail: `${mode}-other@example.test`,
            connectionStatus: "connected",
            reconnectReason: null,
          }),
        );
      });
    });
  },
);

test("preserves static OAuth identity when refreshed identity is unusable", async () => {
  const publicFixture = createPublicFirewallFixture(context, {
    orgRole: "org:admin",
  });
  await publicFixture.run(async () => {
    const custom = await setupCustomOAuthFirewall(
      "configured",
      undefined,
      {
        initial: {
          subject: "static-preserved-user",
          userInfoUsername: "static-preserved-name",
          userInfoEmail: "static-preserved@example.test",
        },
        refresh: {
          subject: "static-untrusted-user",
          invalidIdToken: true,
        },
      },
      publicFixture,
    );

    const refreshed = await custom.request(custom.account.id, true);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({
      headers: {
        Authorization: "Bearer custom-oauth-refreshed-access-token",
      },
    });
    await expect(
      custom.connectors.listCustomConnectorAccounts(
        custom.actor,
        custom.connector.id,
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: custom.account.id,
        externalId: "static-preserved-user",
        externalUsername: "static-preserved-name",
        externalEmail: "static-preserved@example.test",
        connectionStatus: "connected",
        reconnectReason: null,
      }),
    );
  });
});
