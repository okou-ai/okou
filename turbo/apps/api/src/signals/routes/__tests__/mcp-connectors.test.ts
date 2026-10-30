import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { randomUUID } from "node:crypto";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import type { CreateCustomConnectorBody } from "@okouai/api-contracts/contracts/custom-connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { afterEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectorAccountRoutes } from "../connector-accounts";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);

type McpCreateBody = Extract<
  CreateCustomConnectorBody,
  { readonly kind: "mcp" }
>;

function manualMcpConnectorBody(args: {
  readonly slug: string;
  readonly displayName: string;
  readonly endpoint: string;
}): McpCreateBody {
  return {
    kind: "mcp",
    slug: args.slug,
    displayName: args.displayName,
    endpoint: args.endpoint,
    transport: "streamable-http",
    fields: [
      {
        key: "secret",
        label: "API token",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.secret}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
  };
}

function client() {
  return setupApp({ context, routes: mcpConnectorsRoutes })(
    mcpConnectorsContract,
  );
}

function accountClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function headers(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createRunForAgent(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  selections: readonly {
    readonly connectionId: string;
    readonly target: {
      readonly kind: "custom";
      readonly customConnectorId: string;
    };
  }[] = [],
) {
  const { actor, agentId } = owned;
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const thread = await accept(
    setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    ).create({
      headers: headers("clerk-session"),
      body: { agentId, connectorSelections: [...selections] },
    }),
    [201],
  );
  const run = await owned.sendChatRun(actor, {
    agentId,
    threadId: thread.body.id,
    prompt: "Discover MCP connectors",
  });
  const claimed = await owned.claimChatRun(owned.runnerGroup, run.runId);
  return { ...run, token: okouTokenFromClaim(claimed.claim) };
}

function requireConnectedAccountId(
  connector: Awaited<ReturnType<typeof connectors.setCustomConnectorValues>>,
): string {
  if (!connector.connectionId) {
    throw new Error("Expected a connected Custom connector account");
  }
  return connector.connectionId;
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

describe("GET /api/mcp-connectors", () => {
  it("uses the run's exact account and connector projection", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { actor, agentId } = owned;

      const selected = await connectors.createCustomConnector(
        actor,
        manualMcpConnectorBody({
          slug: "_selected-mcp",
          displayName: "Selected MCP",
          endpoint: "https://selected-mcp.example.test/server",
        }),
      );
      const defaultAccountId = requireConnectedAccountId(
        await connectors.setCustomConnectorValues(actor, selected.id, [
          { key: "secret", kind: "secret", value: "default-v1" },
        ]),
      );
      const selectedAccountId = requireConnectedAccountId(
        await connectors.setCustomConnectorValues(
          actor,
          selected.id,
          [{ key: "secret", kind: "secret", value: "selected-v1" }],
          { intent: "add", displayName: "Run account" },
        ),
      );
      const signedHttp = await connectors.createCustomConnector(
        actor,
        manualHttpCustomConnectorCreateBody({
          slug: "_signed-http",
          displayName: "Signed HTTP",
          prefixTemplates: ["https://signed-http.example.test/v1/"],
        }),
      );
      const signedHttpAccountId = requireConnectedAccountId(
        await connectors.setCustomConnectorValues(actor, signedHttp.id, [
          { key: "secret", kind: "secret", value: "signed-http" },
        ]),
      );
      await connectors.updateAgentCustomConnectors(actor, agentId, [
        selected.id,
        signedHttp.id,
      ]);
      const run = await createRunForAgent(owned, [
        {
          connectionId: selectedAccountId,
          target: { kind: "custom", customConnectorId: selected.id },
        },
        {
          connectionId: signedHttpAccountId,
          target: { kind: "custom", customConnectorId: signedHttp.id },
        },
      ]);

      const initialSelected = await accept(
        client().list({ headers: headers(run.token) }),
        [200],
      );
      expect(initialSelected.body.connectors).toStrictEqual([
        {
          target: { kind: "custom", customConnectorId: selected.id },
          connectionId: selectedAccountId,
          slug: "_selected-mcp",
          displayName: "Selected MCP",
          transport: "streamable-http",
          endpoint: "https://selected-mcp.example.test/server",
          runtimeAvailable: true,
          connectionStatus: "connected",
          reconnectReason: null,
          missingRequiredFields: [],
          configuredFieldKeys: ["secret"],
        },
      ]);

      await connectors.updateCustomConnector(actor, selected.id, {
        ...manualMcpConnectorBody({
          slug: "_selected-mcp",
          displayName: "Selected MCP",
          endpoint: "https://selected-mcp.example.test/server",
        }),
        storageVersion: 2,
      });
      await connectors.setCustomConnectorValues(
        actor,
        selected.id,
        [{ key: "secret", kind: "secret", value: "default-v2" }],
        { intent: "reconnect", connectionId: defaultAccountId },
      );
      const postStart = await connectors.createCustomConnector(
        actor,
        manualMcpConnectorBody({
          slug: "_post-start-mcp",
          displayName: "Post-start MCP",
          endpoint: "https://post-start-mcp.example.test/server",
        }),
      );
      await connectors.setCustomConnectorValues(actor, postStart.id, [
        { key: "secret", kind: "secret", value: "post-start" },
      ]);
      await connectors.updateAgentCustomConnectors(
        actor,
        agentId,
        [selected.id, signedHttp.id],
        "remove",
      );
      await connectors.updateAgentCustomConnectors(
        actor,
        agentId,
        [postStart.id],
        "add",
      );
      mockClerkMembership(context, actor, "org:admin");

      const staleSelected = await accept(
        client().list({
          headers: headers(run.token),
        }),
        [200],
      );
      expect(staleSelected.body).toStrictEqual({
        connectors: [
          {
            target: { kind: "custom", customConnectorId: selected.id },
            connectionId: selectedAccountId,
            slug: "_selected-mcp",
            displayName: "Selected MCP",
            transport: "streamable-http",
            endpoint: "https://selected-mcp.example.test/server",
            runtimeAvailable: false,
            connectionStatus: "reconnect-required",
            reconnectReason: "configuration_invalid",
            missingRequiredFields: ["secret"],
            configuredFieldKeys: [],
          },
        ],
      });

      await connectors.updateCustomConnector(actor, selected.id, {
        ...manualMcpConnectorBody({
          slug: "_selected-mcp",
          displayName: "Selected MCP",
          endpoint: "https://selected-mcp.example.test/server",
        }),
        storageVersion: 3,
      });
      await connectors.setCustomConnectorValues(
        actor,
        selected.id,
        [{ key: "secret", kind: "secret", value: "selected-v3" }],
        { intent: "reconnect", connectionId: selectedAccountId },
      );
      const currentSelected = await accept(
        client().list({
          headers: headers(run.token),
        }),
        [200],
      );
      expect(currentSelected.body.connectors).toStrictEqual([
        {
          target: { kind: "custom", customConnectorId: selected.id },
          connectionId: selectedAccountId,
          slug: "_selected-mcp",
          displayName: "Selected MCP",
          transport: "streamable-http",
          endpoint: "https://selected-mcp.example.test/server",
          runtimeAvailable: true,
          connectionStatus: "connected",
          reconnectReason: null,
          missingRequiredFields: [],
          configuredFieldKeys: ["secret"],
        },
      ]);
    });
  });

  it("keeps an admitted no-auth MCP available without checking its account", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { actor, agentId } = owned;

      const body = {
        kind: "mcp",
        slug: "_public-mcp",
        displayName: "Public MCP",
        endpoint: "https://public-mcp.example.test/server",
        transport: "streamable-http",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "none",
      } satisfies McpCreateBody;
      const connector = await connectors.createCustomConnector(actor, body);
      const connectionId = requireConnectedAccountId(
        await connectors.setCustomConnectorValues(actor, connector.id, []),
      );
      await connectors.updateAgentCustomConnectors(actor, agentId, [
        connector.id,
      ]);
      const run = await createRunForAgent(owned);
      const token = run.token;
      await connectors.updateCustomConnector(actor, connector.id, {
        ...body,
        storageVersion: 2,
      });
      await connectors.deleteCustomConnectorAccount(
        actor,
        connector.id,
        connectionId,
      );
      const response = await accept(
        client().list({ headers: headers(token) }),
        [200],
      );
      expect(response.body.connectors).toStrictEqual([
        {
          target: { kind: "custom", customConnectorId: connector.id },
          connectionId,
          slug: body.slug,
          displayName: body.displayName,
          transport: body.transport,
          endpoint: body.endpoint,
          runtimeAvailable: true,
          connectionStatus: "reconnect-required",
          reconnectReason: "account_unavailable",
          missingRequiredFields: [],
          configuredFieldKeys: [],
        },
      ]);
    });
  });

  it("does not fall back when the exact run account is deleted", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { actor, agentId } = owned;

      const selected = await connectors.createCustomConnector(
        actor,
        manualMcpConnectorBody({
          slug: "_deleted-exact-mcp",
          displayName: "Deleted exact MCP",
          endpoint: "https://deleted-exact-mcp.example.test/server",
        }),
      );
      const exactAccountId = requireConnectedAccountId(
        await connectors.setCustomConnectorValues(actor, selected.id, [
          { key: "secret", kind: "secret", value: "exact" },
        ]),
      );
      await connectors.setCustomConnectorValues(
        actor,
        selected.id,
        [{ key: "secret", kind: "secret", value: "healthy-sibling" }],
        { intent: "add", displayName: "Healthy sibling" },
      );
      await connectors.updateAgentCustomConnectors(actor, agentId, [
        selected.id,
      ]);
      const run = await createRunForAgent(owned);
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      mockClerkMembership(context, actor, "org:admin");

      await accept(
        accountClient().delete({
          headers: headers("clerk-session"),
          params: { connectionId: exactAccountId },
          body: {
            target: { kind: "custom", customConnectorId: selected.id },
          },
        }),
        [200],
      );
      const deleted = await accept(
        client().list({
          headers: headers(run.token),
        }),
        [200],
      );
      expect(deleted.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: { kind: "custom", customConnectorId: selected.id },
          runtimeAvailable: false,
        }),
      ]);
    });
  });

  it("requires agent authentication for connector read", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");

    const unauthenticated = await accept(client().list({ headers: {} }), [401]);
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const session = await accept(
      client().list({ headers: headers("clerk-session") }),
      [403],
    );

    expect(unauthenticated.status).toBe(401);
    expect(session.status).toBe(403);
  });
});

describe("POST /api/mcp-connectors/oauth2/reauthorize", () => {
  const ownedReauthorizations: {
    readonly actor: ApiTestUser;
    agentId?: string;
    connectorId?: string;
    runId?: string;
    sandboxToken?: string;
  }[] = [];

  afterEach(async () => {
    for (const owned of ownedReauthorizations.splice(0)) {
      const cleanupRuns = createRunsApi(context);
      if (owned.runId) {
        const current = await cleanupRuns.readRun(owned.actor, owned.runId);
        if (
          current.status === "queued" ||
          current.status === "pending" ||
          current.status === "running"
        ) {
          await cleanupRuns.requestCancelRun(owned.actor, owned.runId, [200]);
        }
        if (
          owned.sandboxToken &&
          (current.status === "pending" ||
            current.status === "running" ||
            current.status === "cancelled")
        ) {
          await createWebhookCallbackApi(context).requestAgentComplete(
            {
              runId: owned.runId,
              exitCode: 1,
              error: "Run cancelled by test cleanup",
            },
            { authorization: `Bearer ${owned.sandboxToken}` },
            [200],
          );
        }
      }
      await flushWaitUntilForTest();
      if (owned.agentId) {
        await createBddApi(context).deleteAgent(owned.actor, owned.agentId);
      }
      if (owned.connectorId) {
        await createConnectorBddApi(context).deleteCustomConnector(
          owned.actor,
          owned.connectorId,
        );
      }
      await flushWaitUntilForTest();
    }
  });

  it.each([
    {
      registration: "cimd",
      offlineAccessRegistered: false,
      dcrTokenEndpointAuthMethod: "none",
    },
    {
      registration: "dcr",
      offlineAccessRegistered: true,
      dcrTokenEndpointAuthMethod: "client_secret_basic",
    },
    {
      registration: "dcr",
      offlineAccessRegistered: true,
      dcrTokenEndpointAuthMethod: "client_secret_post",
    },
    {
      registration: "dcr",
      offlineAccessRegistered: true,
      dcrTokenEndpointAuthMethod: "none",
    },
    {
      registration: "dcr",
      offlineAccessRegistered: false,
      dcrTokenEndpointAuthMethod: "client_secret_basic",
    },
  ] as const)(
    "reauthorizes the parent-resource $registration account with $dcrTokenEndpointAuthMethod and offline access registered=$offlineAccessRegistered",
    async ({
      registration,
      offlineAccessRegistered,
      dcrTokenEndpointAuthMethod,
    }) => {
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      const resource = "https://automatic-mcp.example.test";
      const initialDcrClientId = `automatic-dcr-client-${"x".repeat(1024)}`;
      const replacementDcrClientId = `replacement-dcr-client-${"y".repeat(1024)}`;
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        dcrClientId: initialDcrClientId,
        dcrTokenEndpointAuthMethod,
        tokenEndpointAuthMethodsSupported:
          dcrTokenEndpointAuthMethod === "none"
            ? ["none"]
            : ["none", dcrTokenEndpointAuthMethod],
        dcrDefaultTokenEndpointAuthMethod: "none",
        resource,
        initialExpiresIn: 3600,
        authorizationCodeScopes: ["read", "read", "read admin offline_access"],
        authorizationServerScopes: offlineAccessRegistered
          ? ["read", "write", "offline_access", "unrequested"]
          : ["read", "write", "unrequested"],
      });
      const actor = bdd.user({ orgRole: "org:admin" });
      const owned: (typeof ownedReauthorizations)[number] = { actor };
      ownedReauthorizations.push(owned);
      await runs.grantProEntitlement(actor);
      await runs.ensurePersonalSubscriptionModel(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "MCP scope reauthorization Agent",
      });
      owned.agentId = agent.agentId;
      const connector = await connectors.createCustomConnector(actor, {
        kind: "mcp",
        displayName: "MCP scope reauthorization",
        endpoint: provider.endpoint,
        transport: "streamable-http",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "automatic",
      });
      owned.connectorId = connector.id;
      const firstAuthorization = await connectors.startCustomConnectorOAuth2(
        actor,
        connector.id,
        undefined,
        { intent: "add", displayName: "Pinned account" },
      );
      const firstState = stateFromAuthorizationUrl(firstAuthorization);
      expect(new URL(firstAuthorization).searchParams.get("resource")).toBe(
        resource,
      );
      const firstCallback =
        await connectors.completeCustomConnectorOAuth2Callback({
          code: "pinned-account-code",
          state: firstState,
          iss: provider.issuer,
        });
      expect(firstCallback.headers.get("location")).toBe(
        "https://app.okou.ai/connectors/custom/callback/success",
      );
      expect(provider.tokenBodies[0]?.get("resource")).toBe(resource);
      const secondAuthorization = await connectors.startCustomConnectorOAuth2(
        actor,
        connector.id,
        undefined,
        { intent: "add", displayName: "Sibling account" },
      );
      await connectors.completeCustomConnectorOAuth2Callback({
        code: "sibling-account-code",
        state: stateFromAuthorizationUrl(secondAuthorization),
        iss: provider.issuer,
      });
      const initialAccounts = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      const pinnedAccount = initialAccounts.find((account) => {
        return account.isDefault;
      });
      const siblingAccount = initialAccounts.find((account) => {
        return !account.isDefault;
      });
      if (!pinnedAccount || !siblingAccount) {
        throw new Error("Expected default and sibling MCP accounts");
      }
      await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
        connector.id,
      ]);
      const run = await runs.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "Use the MCP connector with incremental scope",
      });
      owned.runId = run.runId;
      expect(run.status).toBe("pending");
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      owned.sandboxToken = claim.sandboxToken;
      const okouToken = claim.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected the claimed run to include an Okou token");
      }
      const firewall = createFirewallApi(context);
      const connectorKey = connector.id.replaceAll("-", "");
      const firewallName = `custom_connector_${connectorKey}`;
      const useAccount = async () => {
        const refreshed = await firewall.requestFirewallAuth(
          { authorization: `Bearer ${claim.sandboxToken}` },
          {
            encryptedSecrets: firewall.encryptedSecretsBody({}),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate(`CUSTOM_${connectorKey}_S___OAUTH_ACCESS_TOKEN`)}`,
            },
            matchedFirewall: {
              name: firewallName,
              apiId: `${firewallName}:0`,
              customConnectorId: connector.id,
              sourceId: pinnedAccount.id,
              routingVariables: {},
            },
            forceRefresh: true,
          },
          [200],
        );
        expect(refreshed.body).toMatchObject({
          headers: {
            Authorization: "Bearer automatic-refreshed-access-token",
          },
        });
      };
      const registrationCount = provider.registrationBodies.length;
      if (registration === "dcr") {
        expect(provider.registrationBodies[0]?.token_endpoint_auth_method).toBe(
          dcrTokenEndpointAuthMethod,
        );
      }
      provider.advertiseAuthorizationServers([
        provider.issuer,
        "https://alternate-issuer.example.test",
      ]);
      provider.advertiseAuthorizationServerScopes([
        "read",
        "admin",
        "offline_access",
        "unrequested",
      ]);
      if (registration === "dcr" && !offlineAccessRegistered) {
        const rejected = await accept(
          client().reauthorizeOAuth({
            headers: headers(okouToken),
            body: {
              target: { kind: "custom", customConnectorId: connector.id },
              scopes: ["admin"],
            },
          }),
          [409],
        );
        expect(rejected.body).toMatchObject({
          error: { code: "MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT" },
        });
        expect(provider.registrationBodies).toHaveLength(registrationCount);
        return;
      }

      const response = await accept(
        client().reauthorizeOAuth({
          headers: headers(okouToken),
          body: {
            target: { kind: "custom", customConnectorId: connector.id },
            scopes: ["admin"],
          },
        }),
        [200],
      );

      const authorizationUrl = new URL(response.body.authorizationUrl);
      expect(authorizationUrl.searchParams.get("resource")).toBe(resource);
      expect(authorizationUrl.searchParams.get("scope")).toBe(
        "read admin offline_access",
      );
      expect(response.body).toMatchObject({
        kind: "oauth",
        expiresAt: expect.any(String),
      });
      expect(provider.registrationBodies).toHaveLength(registrationCount);
      const reauthorizationState = stateFromAuthorizationUrl(
        response.body.authorizationUrl,
      );
      const reauthorizationCallback =
        await connectors.completeCustomConnectorOAuth2Callback({
          code: "scope-upgrade-code",
          state: reauthorizationState,
          iss: provider.issuer,
        });
      expect(reauthorizationCallback.headers.get("location")).toBe(
        "https://app.okou.ai/connectors/custom/callback/success",
      );
      expect(provider.tokenBodies.at(-1)?.get("resource")).toBe(resource);
      const upgradedAccounts = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      expect(
        upgradedAccounts.find((account) => {
          return account.id === pinnedAccount.id;
        })?.oauthScopes,
      ).toStrictEqual(["read", "admin", "offline_access"]);
      expect(
        upgradedAccounts.find((account) => {
          return account.id === siblingAccount.id;
        })?.oauthScopes,
      ).toStrictEqual(["read"]);
      await useAccount();
      const replacementProvider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        dcrTokenEndpointAuthMethod,
        endpoint: provider.endpoint,
        resource,
        issuer: "https://alternate-issuer.example.test",
        dcrClientId: replacementDcrClientId,
        dcrClientSecret: "replacement-dcr-secret",
        initialExpiresIn: 3600,
      });
      const changedAuthority = await accept(
        client().reauthorizeOAuth({
          headers: headers(okouToken),
          body: {
            target: { kind: "custom", customConnectorId: connector.id },
            scopes: ["owner"],
          },
        }),
        [registration === "dcr" ? 409 : 200],
      );
      let changedAuthorizationUrl: string;
      if (changedAuthority.status === 409) {
        expect(changedAuthority.body).toMatchObject({
          error: {
            code: "MCP_OAUTH_BINDING_CHANGED",
            message: expect.stringContaining("Reconnect"),
          },
        });
        expect(replacementProvider.tokenBodies).toHaveLength(0);
        expect(replacementProvider.tokenAuthorizationHeaders).toHaveLength(0);
        changedAuthorizationUrl = await connectors.startCustomConnectorOAuth2(
          actor,
          connector.id,
          undefined,
          { intent: "reconnect", connectionId: pinnedAccount.id },
        );
        expect(replacementProvider.registrationBodies).toHaveLength(1);
        expect(
          new URL(changedAuthorizationUrl).searchParams.get("client_id"),
        ).toBe(replacementDcrClientId);
      } else {
        changedAuthorizationUrl = changedAuthority.body.authorizationUrl;
      }
      expect(new URL(changedAuthorizationUrl).origin).toBe(
        replacementProvider.issuer,
      );
      const changedCallback =
        await connectors.completeCustomConnectorOAuth2Callback({
          code: "changed-authority-code",
          state: stateFromAuthorizationUrl(changedAuthorizationUrl),
          iss: replacementProvider.issuer,
        });
      expect(changedCallback.headers.get("location")).toBe(
        "https://app.okou.ai/connectors/custom/callback/success",
      );
      expect(replacementProvider.tokenBodies[0]?.get("resource")).toBe(
        resource,
      );
      await useAccount();
      expect(replacementProvider.tokenBodies.at(-1)?.get("grant_type")).toBe(
        "refresh_token",
      );
      expect(replacementProvider.tokenAuthorizationHeaders).not.toContain(
        `Basic ${Buffer.from(`${initialDcrClientId}:automatic-dcr-secret`).toString("base64")}`,
      );
      expect(
        replacementProvider.tokenBodies.map((body) => {
          return body.get("client_secret");
        }),
      ).not.toContain("automatic-dcr-secret");
      const reconnectedAccounts = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      expect(
        reconnectedAccounts.find((account) => {
          return account.id === pinnedAccount.id;
        }),
      ).toMatchObject({ connectionStatus: "connected", reconnectReason: null });
      expect(
        reconnectedAccounts.find((account) => {
          return account.id === siblingAccount.id;
        })?.oauthScopes,
      ).toStrictEqual(["read"]);
      await runs.requestCancelRun(actor, run.runId, [200]);
    },
  );

  it("discovers Automatic no-auth accounts without offering OAuth reauthorization", async () => {
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "none",
    });
    const actor = bdd.user({ orgRole: "org:admin" });
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP no-auth reauthorization Agent",
    });
    const connector = await connectors.createCustomConnector(actor, {
      kind: "mcp",
      displayName: "MCP no-auth reauthorization",
      endpoint: "https://automatic-mcp.example.test/server",
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });
    const connected = await connectors.requestStartCustomConnectorOAuth2(
      actor,
      connector.id,
      [200],
      agent.agentId,
    );
    if ("error" in connected.body || connected.body.result !== "connected") {
      throw new Error("Expected Automatic MCP no-auth connection");
    }
    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      connector.id,
    ]);
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the no-auth MCP connector",
    });
    expect(run.status).toBe("pending");
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);
    const okouToken = claim.platformEnvironment.OKOU_TOKEN;
    if (!okouToken) {
      throw new Error("Expected the claimed run to include an Okou token");
    }

    const discovery = await accept(
      client().list({ headers: headers(okouToken) }),
      [200],
    );
    expect(discovery.body.connectors).toStrictEqual([
      expect.objectContaining({
        target: { kind: "custom", customConnectorId: connector.id },
        runtimeAvailable: true,
      }),
    ]);

    const response = await accept(
      client().reauthorizeOAuth({
        headers: headers(okouToken),
        body: {
          target: { kind: "custom", customConnectorId: connector.id },
          scopes: ["admin"],
        },
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
    await runs.requestCancelRun(actor, run.runId, [200]);
  });

  it("requires agent authentication for connector write", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { actor } = owned;
      mockClerkMembership(context, actor, "org:admin");
      const connectorId = randomUUID();

      const unauthenticated = await accept(
        client().reauthorizeOAuth({
          headers: {},
          body: {
            target: { kind: "custom", customConnectorId: connectorId },
            scopes: ["admin"],
          },
        }),
        [401],
      );
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const session = await accept(
        client().reauthorizeOAuth({
          headers: headers("clerk-session"),
          body: {
            target: { kind: "custom", customConnectorId: connectorId },
            scopes: ["admin"],
          },
        }),
        [403],
      );

      expect(unauthenticated.status).toBe(401);
      expect(session.status).toBe(403);
    });
  });
});
