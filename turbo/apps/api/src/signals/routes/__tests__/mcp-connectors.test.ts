import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
  type CreateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { readCustomConnectorOAuthStorageState } from "./helpers/connector-credential-storage-state";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { mcpConnectorsRoutes } from "../mcp-connectors";

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

async function createRunForAgent(actor: ApiTestUser, agentId: string) {
  return await runs.createDirectRun(actor, {
    agentId,
    prompt: "Discover MCP connectors",
    modelProviderType: "anthropic-api-key",
    vars: { OKOU_AGENT_ID: agentId },
    secrets: { OKOU_TOKEN: "mcp-discovery-okou-token" },
  });
}

function exactConnectorRunToken(args: {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly customConnectorSourceIds: Readonly<Record<string, string>>;
  readonly capabilities?: readonly Capability[];
}): string {
  if (!args.actor.orgId) {
    throw new Error("MCP run tokens require an org-scoped actor");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.actor.userId,
    orgId: args.actor.orgId,
    runId: args.runId,
    capabilities: [...(args.capabilities ?? ["connector:read"])],
    customConnectorSourceIds: args.customConnectorSourceIds,
    iat: seconds,
    exp: seconds + 3600,
  });
}

function requireConnectedAccountId(
  connector: Awaited<ReturnType<typeof connectors.setCustomConnectorValues>>,
): string {
  if (!connector.connectedAccountId) {
    throw new Error("Expected a connected Custom connector account");
  }
  return connector.connectedAccountId;
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
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP Discovery Agent",
    });
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
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
    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      selected.id,
      signedHttp.id,
    ]);
    const run = await createRunForAgent(actor, agent.agentId);
    const exactSources = {
      [selected.id]: selectedAccountId,
      [signedHttp.id]: signedHttpAccountId,
    };

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
      agent.agentId,
      [selected.id, signedHttp.id],
      "remove",
    );
    await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [postStart.id],
      "add",
    );
    mockClerkMembership(context, actor, "org:admin");

    const staleSelected = await accept(
      client().list({
        headers: headers(
          exactConnectorRunToken({
            actor,
            runId: run.runId,
            customConnectorSourceIds: exactSources,
          }),
        ),
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
          connected: false,
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
        headers: headers(
          exactConnectorRunToken({
            actor,
            runId: run.runId,
            customConnectorSourceIds: exactSources,
          }),
        ),
      }),
      [200],
    );
    expect(currentSelected.body.connectors).toStrictEqual([
      expect.objectContaining({
        target: { kind: "custom", customConnectorId: selected.id },
        connected: true,
      }),
    ]);

    const peer = bdd.user({ orgId: actor.orgId });
    const peerResponse = await accept(
      client().list({
        headers: headers(
          exactConnectorRunToken({
            actor: peer,
            runId: run.runId,
            customConnectorSourceIds: exactSources,
          }),
        ),
      }),
      [200],
    );
    const foreign = bdd.user();
    mockClerkMembership(context, foreign, "org:admin");
    const foreignResponse = await accept(
      client().list({
        headers: headers(
          exactConnectorRunToken({
            actor: foreign,
            runId: run.runId,
            customConnectorSourceIds: exactSources,
          }),
        ),
      }),
      [200],
    );

    expect(peerResponse.body).toStrictEqual({ connectors: [] });
    expect(foreignResponse.body).toStrictEqual({ connectors: [] });
  });

  it("keeps an admitted no-auth MCP available without checking its account", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Public MCP Agent",
    });
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
    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      connector.id,
    ]);
    const run = await createRunForAgent(actor, agent.agentId);
    const token = exactConnectorRunToken({
      actor,
      runId: run.runId,
      customConnectorSourceIds: { [connector.id]: connectionId },
    });
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
        connected: true,
      },
    ]);
  });

  it("does not fall back when the exact run account is deleted or mismatched", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP exact identity Agent",
    });
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
    const other = await connectors.createCustomConnector(
      actor,
      manualMcpConnectorBody({
        slug: "_other-logical-mcp",
        displayName: "Other logical MCP",
        endpoint: "https://other-logical-mcp.example.test/server",
      }),
    );
    const otherAccountId = requireConnectedAccountId(
      await connectors.setCustomConnectorValues(actor, other.id, [
        { key: "secret", kind: "secret", value: "other" },
      ]),
    );
    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      selected.id,
    ]);
    const run = await createRunForAgent(actor, agent.agentId);
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
        headers: headers(
          exactConnectorRunToken({
            actor,
            runId: run.runId,
            customConnectorSourceIds: { [selected.id]: exactAccountId },
          }),
        ),
      }),
      [200],
    );
    expect(deleted.body.connectors).toStrictEqual([
      expect.objectContaining({
        target: { kind: "custom", customConnectorId: selected.id },
        connected: false,
      }),
    ]);

    const mismatched = await accept(
      client().list({
        headers: headers(
          exactConnectorRunToken({
            actor,
            runId: run.runId,
            customConnectorSourceIds: { [selected.id]: otherAccountId },
          }),
        ),
      }),
      [200],
    );
    expect(mismatched.body.connectors).toStrictEqual([
      expect.objectContaining({
        target: { kind: "custom", customConnectorId: selected.id },
        connected: false,
      }),
    ]);
  });

  it("fails closed for legacy tokens without an exact projection", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Legacy MCP discovery Agent",
    });
    const connected = await connectors.createCustomConnector(
      actor,
      manualMcpConnectorBody({
        slug: "_legacy-default-mcp",
        displayName: "Legacy default MCP",
        endpoint: "https://legacy-default-mcp.example.test/server",
      }),
    );
    await connectors.setCustomConnectorSecret(actor, connected.id, "legacy");
    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      connected.id,
    ]);
    const run = await createRunForAgent(actor, agent.agentId);
    mockClerkMembership(context, actor, "org:admin");

    const response = await accept(
      client().list({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, run.runId, [
            "connector:read",
          ]),
        ),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ connectors: [] });
  });

  it("returns an empty authoritative result when the token run is absent", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");

    const response = await accept(
      client().list({
        headers: headers(
          exactConnectorRunToken({
            actor,
            runId: randomUUID(),
            customConnectorSourceIds: { [randomUUID()]: randomUUID() },
          }),
        ),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ connectors: [] });
  });

  it("requires agent authentication with connector read capability", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");
    const runId = randomUUID();

    const unauthenticated = await accept(client().list({ headers: {} }), [401]);
    const missingCapability = await accept(
      client().list({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, runId, []),
        ),
      }),
      [403],
    );
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const session = await accept(
      client().list({ headers: headers("clerk-session") }),
      [403],
    );

    expect(unauthenticated.status).toBe(401);
    expect(missingCapability.status).toBe(403);
    expect(session.status).toBe(403);
  });
});

describe("POST /api/mcp-connectors/oauth2/reauthorize", () => {
  it.each(["cimd", "dcr"] as const)(
    "reauthorizes the exact Automatic OAuth account pinned to the run with %s",
    async (registration) => {
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        initialExpiresIn: 3600,
        authorizationCodeScopes: ["read", "read", "read admin"],
      });
      const actor = bdd.user({ orgRole: "org:admin" });
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "MCP scope reauthorization Agent",
      });
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CustomConnectorMcp]: true,
      });
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
      const firstAuthorization = await connectors.startCustomConnectorOAuth2(
        actor,
        connector.id,
        undefined,
        { intent: "add", displayName: "Pinned account" },
      );
      const firstState = stateFromAuthorizationUrl(firstAuthorization);
      await expect(
        readCustomConnectorOAuthStorageState(context, firstState),
      ).resolves.toMatchObject({
        custom_oauth_state: {
          auth_mode: "automatic",
          context_valid: true,
        },
      });
      await connectors.completeCustomConnectorOAuth2Callback({
        code: "pinned-account-code",
        state: firstState,
        iss: provider.issuer,
      });
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
      const run = await runs.createRun(actor, {
        agentId: agent.agentId,
        prompt: "Use the MCP connector with incremental scope",
        modelProvider: "anthropic-api-key",
      });
      expect(run.status).toBe("pending");
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      const okouToken = claim.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected the claimed run to include an Okou token");
      }
      const registrationCount = provider.registrationBodies.length;
      provider.advertiseAuthorizationServers([
        "https://alternate-issuer.example.test",
        provider.issuer,
      ]);

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
      expect(authorizationUrl.searchParams.get("scope")).toBe("read admin");
      expect(response.body).toMatchObject({
        kind: "oauth",
        expiresAt: expect.any(String),
      });
      expect(provider.registrationBodies).toHaveLength(registrationCount);
      const reauthorizationState = stateFromAuthorizationUrl(
        response.body.authorizationUrl,
      );
      await expect(
        readCustomConnectorOAuthStorageState(context, reauthorizationState),
      ).resolves.toMatchObject({
        custom_oauth_state: {
          auth_mode: "automatic",
          context_valid: true,
        },
      });
      await connectors.completeCustomConnectorOAuth2Callback({
        code: "scope-upgrade-code",
        state: reauthorizationState,
        iss: provider.issuer,
      });
      const upgradedAccounts = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      expect(
        upgradedAccounts.find((account) => {
          return account.id === pinnedAccount.id;
        })?.oauthScopes,
      ).toStrictEqual(["read", "admin"]);
      expect(
        upgradedAccounts.find((account) => {
          return account.id === siblingAccount.id;
        })?.oauthScopes,
      ).toStrictEqual(["read"]);
      provider.advertiseAuthorizationServers([
        "https://alternate-issuer.example.test",
      ]);
      const removedIssuer = await accept(
        client().reauthorizeOAuth({
          headers: headers(okouToken),
          body: {
            target: { kind: "custom", customConnectorId: connector.id },
            scopes: ["owner"],
          },
        }),
        [409],
      );
      expect(removedIssuer.body.error).toStrictEqual({
        code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.BINDING_CHANGED,
        message:
          "Automatic MCP OAuth authorization changed. Reconnect the account and try again.",
      });
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
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP no-auth reauthorization Agent",
    });
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
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
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the no-auth MCP connector",
      modelProvider: "anthropic-api-key",
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
        connected: true,
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

  it("requires agent authentication with connector write capability", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");
    const runId = randomUUID();
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
    const missingCapability = await accept(
      client().reauthorizeOAuth({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, runId, []),
        ),
        body: {
          target: { kind: "custom", customConnectorId: connectorId },
          scopes: ["admin"],
        },
      }),
      [403],
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
    const unpinned = await accept(
      client().reauthorizeOAuth({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, runId, [
            "connector:write",
          ]),
        ),
        body: {
          target: { kind: "custom", customConnectorId: connectorId },
          scopes: ["admin"],
        },
      }),
      [409],
    );
    const malformedScope = await accept(
      client().reauthorizeOAuth({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, runId, [
            "connector:write",
          ]),
        ),
        body: {
          target: { kind: "custom", customConnectorId: connectorId },
          scopes: ["invalid scope"],
        },
      }),
      [400],
    );

    expect(unauthenticated.status).toBe(401);
    expect(missingCapability.status).toBe(403);
    expect(session.status).toBe(403);
    expect(unpinned.body.error.code).toBe("CONFLICT");
    expect(malformedScope.body.error.code).toBe("BAD_REQUEST");
  });
});
