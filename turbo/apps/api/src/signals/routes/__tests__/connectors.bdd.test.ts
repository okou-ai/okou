import { randomUUID } from "node:crypto";

import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
  type CreateCustomConnectorBody,
  type SaveCustomConnectorProposalBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import type { ExecutionFirewallEntry } from "@okouai/connectors/firewall-types";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getCustomConnectorSkillName } from "@okouai/core/storage-names";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { chatEventsRoutes } from "../chat-events";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCatalogRoutes } from "../connector-catalog";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsGetRoutes } from "../custom-connectors-get";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import { customConnectorsUpdateRoutes } from "../custom-connectors-update";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAutomaticMcpOAuthProvider,
  mockBase44OAuthProvider,
  mockCustomConnectorOAuth2Provider,
  mockDatadogConnectorOAuth,
  mockGitHubConnectorOAuth,
  mockSlackConnectorOAuth,
  mockSlockOAuthProvider,
  mockStripeCliDashboardAuth,
  mockTestOAuthAuthCodeProvider,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  okouTokenFromExecution,
  type RunnerExecutionInput,
} from "./helpers/chat-events-fixture";
import { mockClerkUsers } from "./helpers/clerk-users";
import {
  marketingRewardConsumer,
  settleMarketingRequest,
} from "./helpers/marketing-reward-consumer";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const routeMocks = createRouteMocks(context);

const DATADOG_READ_SCOPES = Object.freeze([
  "dashboards_read",
  "events_read",
  "incident_read",
  "logs_read_index_data",
  "metrics_read",
  "monitors_read",
  "slos_read",
]);

function oauthStateFromUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error(`Expected state parameter in ${authorizationUrl}`);
  }
  return state;
}

function redirectLocationUrl(headers: Headers): URL {
  const location = headers.get("location");
  if (!location) {
    throw new Error("Expected Location redirect header");
  }
  return new URL(location, "https://www.okou.ai");
}

function expectClearedOAuthCookies(headers: Headers): void {
  const setCookies = headers.getSetCookie();
  for (const name of [
    "connector_oauth_state",
    "connector_oauth_pkce",
    "connector_oauth_context",
  ]) {
    expect(
      setCookies.some((cookie) => {
        return cookie.startsWith(`${name}=;`) && cookie.includes("Max-Age=0");
      }),
    ).toBeTruthy();
  }
}

async function readConnectorCatalogStatus(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const client = setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
  const response = await accept(
    client.status({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  return response.body;
}

async function readUsagePackCredits(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const client = setupApp({ context, routes: billingUsagePackCreditsRoutes })(
    billingUsagePackCreditsContract,
  );
  const response = await accept(
    client.get({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  return response.body;
}

function oauthHttpBody(args: {
  readonly displayName: string;
  readonly prefix: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly clientSecret?: string;
}): HttpCreateBody {
  return {
    displayName: args.displayName,
    prefixTemplates: [args.prefix],
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "branded-oauth-client-id",
      authorizationUrl: args.authorizationUrl,
      tokenUrl: args.tokenUrl,
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: [...args.scopes],
      authorizationParams: {},
      ...(args.clientSecret === undefined
        ? {}
        : { clientSecret: args.clientSecret }),
    },
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
    ],
    queryInjections: [],
  };
}

function oauthMcpBody(args: {
  readonly displayName: string;
  readonly endpoint: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly clientSecret?: string;
}): McpCreateBody {
  return {
    kind: "mcp",
    displayName: args.displayName,
    endpoint: args.endpoint,
    transport: "streamable-http",
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "branded-mcp-client-id",
      authorizationUrl: args.authorizationUrl,
      tokenUrl: args.tokenUrl,
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: [...args.scopes],
      authorizationParams: {},
      ...(args.clientSecret === undefined
        ? {}
        : { clientSecret: args.clientSecret }),
    },
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
    ],
    queryInjections: [],
  };
}

const LITERAL_ONLY_MESSAGE =
  "Manual custom connector injections must reference a declared secret or variable field";

type HttpCreateBody = Exclude<CreateCustomConnectorBody, { kind: "mcp" }>;
type McpCreateBody = Extract<CreateCustomConnectorBody, { kind: "mcp" }>;

function errorMessage(body: unknown): string {
  expectApiError(body);
  return body.error.message;
}

function errorCode(body: unknown): string | undefined {
  expectApiError(body);
  return body.error.code;
}

function memberOf(admin: ApiTestUser): ApiTestUser {
  return bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
}

function literalOnlyHttpBody(displayName: string): HttpCreateBody {
  return {
    displayName,
    prefixTemplates: [`https://api.${randomUUID()}.example.test/v1`],
    fields: [
      { key: "api_key", label: "API key", kind: "secret", required: true },
    ],
    headerInjections: [{ name: "X-Public-Mode", valueTemplate: "public" }],
    queryInjections: [],
  };
}

function subdomainProposal(
  values: SaveCustomConnectorProposalBody["values"],
): SaveCustomConnectorProposalBody {
  return {
    proposal: {
      operation: "create",
      displayName: "Tenant API",
      prefixTemplates: ["https://{{variables.subdomain}}.tenant.example.test/"],
      fields: [
        { key: "api_key", label: "API key", kind: "secret", required: true },
        {
          key: "subdomain",
          label: "Subdomain",
          kind: "variable",
          required: true,
        },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.api_key}}" },
      ],
      queryInjections: [
        { name: "tenant", valueTemplate: "{{variables.subdomain}}" },
      ],
    },
    values: [...values],
  };
}

function manualMcpBody(displayName: string): McpCreateBody {
  return {
    kind: "mcp",
    displayName,
    endpoint: `https://mcp-${randomUUID()}.example.test/mcp`,
    transport: "streamable-http",
    authMode: "manual",
    fields: [
      { key: "secret", label: "Secret", kind: "secret", required: true },
    ],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
    ],
    queryInjections: [],
  };
}

function automaticProvider(
  options: Omit<
    Parameters<typeof mockAutomaticMcpOAuthProvider>[1],
    "endpoint" | "issuer"
  >,
) {
  return mockAutomaticMcpOAuthProvider(context, {
    ...options,
    endpoint: `https://automatic-${randomUUID()}.example.test/server`,
    issuer: `https://issuer-${randomUUID()}.example.test`,
  });
}

async function createAutomaticConnector(admin: ApiTestUser, endpoint: string) {
  return await connectors.createCustomConnector(admin, {
    kind: "mcp",
    displayName: "Automatic MCP",
    endpoint,
    transport: "streamable-http",
    authMode: "automatic",
    fields: [],
    headerInjections: [],
    queryInjections: [],
  });
}

function lifecycleBody(): HttpCreateBody {
  return manualHttpCustomConnectorCreateBody({
    displayName: "Lifecycle API",
    prefixTemplates: [`https://api.${randomUUID()}.example.test/v1/`],
  });
}

function versionedPrefix(body: HttpCreateBody, version: number): string {
  const [prefix] = body.prefixTemplates;
  if (prefix === undefined) {
    throw new Error("Expected a prefix template");
  }
  return prefix.replace("/v1/", `/v${version}/`);
}

async function updateLifecyclePrefix(
  admin: ApiTestUser,
  connectorId: string,
  body: HttpCreateBody,
  version: number,
) {
  return await connectors.updateCustomConnector(admin, connectorId, {
    ...body,
    displayName: `Lifecycle API v${version}`,
    prefixTemplates: [versionedPrefix(body, version)],
  });
}

async function expectExactReconnectSemantics(
  body: CreateCustomConnectorBody,
): Promise<void> {
  const admin = bdd.user();
  bdd.acceptStorageWrites();
  const connector = await connectors.createCustomConnector(admin, body);
  const secret = (value: string) => {
    return [{ key: "secret", kind: "secret" as const, value }];
  };

  const added = await connectors.setCustomConnectorValues(
    admin,
    connector.id,
    secret("first-secret"),
    { intent: "add" },
  );
  await expect(
    connectors.listCustomConnectorAccounts(admin, connector.id),
  ).resolves.toMatchObject([
    { id: added.connectionId, isDefault: true, connectionStatus: "connected" },
  ]);

  const reconnected = await connectors.setCustomConnectorValues(
    admin,
    connector.id,
    secret("replacement-secret"),
    { intent: "reconnect", connectionId: added.connectionId },
  );
  expect(reconnected.connectionId).toBe(added.connectionId);

  const sibling = await connectors.setCustomConnectorValues(
    admin,
    connector.id,
    secret("sibling-secret"),
    { intent: "add", displayName: "Personal" },
  );
  expect(sibling.connectionId).not.toBe(added.connectionId);
  const accounts = await connectors.listCustomConnectorAccounts(
    admin,
    connector.id,
  );
  expect(
    accounts.find((account) => {
      return account.id === added.connectionId;
    }),
  ).toMatchObject({ isDefault: true, connectionStatus: "connected" });
  expect(
    accounts.find((account) => {
      return account.id === sibling.connectionId;
    }),
  ).toMatchObject({ displayName: "Personal", connectionStatus: "connected" });
}

async function startAgainstUnavailableProvider(
  failure:
    | { readonly resourceMetadataStatus: number }
    | { readonly dcrFailureStatus: number },
) {
  const admin = bdd.user();
  const provider = automaticProvider({
    registration: "dcr",
    authentication: "oauth",
    ...failure,
  });
  const connector = await createAutomaticConnector(admin, provider.endpoint);
  const started = await connectors.requestStartCustomConnectorOAuth2(
    admin,
    connector.id,
    [502],
  );
  return {
    code: errorCode(started.body),
    registrations: provider.registrationBodies.length,
  };
}

async function sharedSecretsGiven() {
  const admin = bdd.user();
  const member = memberOf(admin);
  const adminElsewhere = bdd.user({ userId: admin.userId });
  const shared = await connectors.createCustomConnector(
    admin,
    manualHttpCustomConnectorCreateBody({
      displayName: "Shared API",
      prefixTemplates: [`https://api.${randomUUID()}.example.test/v1/`],
    }),
  );
  await connectors.setCustomConnectorSecret(
    member,
    shared.id,
    "member-secret-value",
  );
  return { admin, member, adminElsewhere, shared };
}

async function connectAndRotateAdminSecret(
  admin: ApiTestUser,
  connectorId: string,
): Promise<string> {
  const connected = await connectors.setCustomConnectorValues(
    admin,
    connectorId,
    [{ key: "secret", kind: "secret", value: "admin-secret-value" }],
  );
  await connectors.setCustomConnectorSecret(
    admin,
    connectorId,
    "admin-rotated-secret",
    [200],
    { intent: "reconnect", connectionId: connected.connectionId },
  );
  return connected.connectionId;
}

async function connectedManualMcp(admin: ApiTestUser) {
  bdd.acceptStorageWrites();
  const body = manualMcpBody("Manual MCP");
  const created = await connectors.createCustomConnector(admin, body);
  await connectors.setCustomConnectorSecret(
    admin,
    created.id,
    "manual-mcp-secret",
  );
  return { body, created };
}

async function moveMcpEndpoint(
  admin: ApiTestUser,
  connectorId: string,
  body: McpCreateBody,
) {
  const movedEndpoint = body.endpoint.replace("/mcp", "/v2/server");
  const moved = await connectors.updateCustomConnector(admin, connectorId, {
    ...body,
    endpoint: movedEndpoint,
  });
  return { moved, movedEndpoint };
}

function noAuthHttpBody(): HttpCreateBody {
  return {
    displayName: "Regional API",
    prefixTemplates: [
      `https://{{variables.region}}.${randomUUID()}.example.test/v1/`,
    ],
    authMode: "none",
    fields: [
      { key: "region", label: "Region", kind: "variable", required: true },
    ],
    headerInjections: [],
    queryInjections: [],
  };
}

async function connectRegion(
  admin: ApiTestUser,
  connectorId: string,
  region: string,
  account?: ConnectorAccountMutationIntent,
) {
  return await connectors.setCustomConnectorValues(
    admin,
    connectorId,
    [{ key: "region", kind: "variable", value: region }],
    account,
  );
}

async function connectedAccounts(admin: ApiTestUser, connectorId: string) {
  const accounts = await connectors.listCustomConnectorAccounts(
    admin,
    connectorId,
  );
  return accounts.filter((account) => {
    return account.connectionStatus === "connected";
  });
}

function guardedMcpBody(
  endpoint: string,
  headerName = "Authorization",
): McpCreateBody {
  return {
    ...manualMcpBody("Guarded MCP"),
    endpoint,
    headerInjections: [
      { name: headerName, valueTemplate: "Bearer {{secrets.secret}}" },
    ],
  };
}

async function createOptionalKeyConnector(admin: ApiTestUser) {
  return await connectors.createCustomConnector(admin, {
    displayName: "Optional key",
    prefixTemplates: [`https://api.${randomUUID()}.example.test/v1`],
    fields: [
      { key: "api_key", label: "API key", kind: "secret", required: false },
    ],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{secrets.api_key}}" },
    ],
    queryInjections: [],
  });
}

async function connectApiDeviceSession(member: ApiTestUser) {
  await connectors.updateFeatureSwitches(member, {
    [FeatureSwitchKey.TestOauthConnector]: true,
  });
  mockTestOAuthDeviceConnectorProvider();
  const started = await connectors.startDeviceAuth(
    member,
    "test-oauth-device",
    "api",
  );
  const polled = await connectors.pollDeviceAuth(
    member,
    "test-oauth-device",
    started.sessionId,
    started.sessionToken,
  );
  if (polled.status !== "complete") {
    throw new Error(`Expected a completed session, got ${polled.status}`);
  }
  return polled;
}

async function connectOpenAi(member: ApiTestUser) {
  return await connectors.connectManualGrant(member, "openai", "api-token", {
    apiKey: "  sk-bdd-openai-key  ",
  });
}

async function addTwoDeviceAccounts(member: ApiTestUser) {
  await connectors.updateFeatureSwitches(member, {
    [FeatureSwitchKey.TestOauthConnector]: true,
  });
  const provider = mockTestOAuthDeviceConnectorProvider();
  const addSession = async () => {
    const started = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
    );
    const polled = await connectors.requestDeviceAuthPoll(
      member,
      "test-oauth-device",
      started.sessionId,
      started.sessionToken,
      [200],
    );
    if (!("status" in polled.body) || polled.body.status !== "complete") {
      throw new Error(
        `Expected a completed session, got ${JSON.stringify(polled.body)}`,
      );
    }
    return { started, connectionId: polled.body.connectionId };
  };
  const first = await addSession();
  provider.setSubject("test-oauth-device-sibling");
  const sibling = await addSession();
  return { first, sibling };
}

describe("connectors BDD", () => {
  it("connectors.bdd-020 validates external-code auth boundaries without using rollout as authorization", async () => {
    const member = bdd.user();

    const anonymous = await connectors.requestExternalCodeStart(
      null,
      "aws",
      "cli",
      [401],
    );
    expect(errorCode(anonymous.body)).toBe("UNAUTHORIZED");

    const openai = await connectors.requestExternalCodeStart(
      member,
      "openai",
      "api-token",
      [400],
    );
    expect(errorMessage(openai.body)).toContain(
      "openai api-token auth method does not use an external-code grant",
    );

    const aws = await connectors.startExternalCode(member, "aws", "cli");
    expect(aws).toMatchObject({ connectorSlug: "aws", status: "pending" });
  });

  it("connectors.bdd-002 (1/4) rejects callers without a workspace and shows OpenAI as available but unconnected", async () => {
    const member = bdd.user();
    const anonymous = await connectors.requestListConnectors(null, [401]);
    expect(errorCode(anonymous.body)).toBe("UNAUTHORIZED");
    const orgless = await connectors.requestListConnectors(
      bdd.user({ orgId: null }),
      [401],
    );
    expect(errorCode(orgless.body)).toBe("UNAUTHORIZED");

    await expect(
      connectors.listBuiltinConnectors(member),
    ).resolves.toStrictEqual({ connectors: [] });
    const search = await connectors.searchConnectors(member, "OPENAI");
    expect(
      search.connectors.find((connector) => {
        return connector.slug === "openai";
      })?.authMethods,
    ).toStrictEqual(["api-token"]);
    const before = await connectors.requestBuiltinConnectorAccounts(
      member,
      "openai",
      [200],
    );
    expect(before.body.defaultConnection).toBeNull();
  });

  it("connectors.bdd-002 (2/4) rejects an unknown grant field and connects a trimmed OpenAI API key", async () => {
    const member = bdd.user();
    const bad = await connectors.requestManualGrant(
      member,
      "openai",
      "api-token",
      { unexpectedField: "unexpected-value" },
      { statuses: [400] },
    );
    expect(errorMessage(bad.body)).toContain("apiKey");
    expect(JSON.stringify(bad.body)).not.toContain("unexpectedField");
    expect(JSON.stringify(bad.body)).not.toContain("unexpected-value");

    const account = await connectOpenAi(member);
    expect(account).toMatchObject({
      authMethod: "api-token",
      connectionStatus: "connected",
      oauthScopes: null,
    });
    const listed = await connectors.listBuiltinConnectors(member);
    expect(
      listed.connectors.map((connector) => {
        return connector.id;
      }),
    ).toContain(account.id);
    expect(JSON.stringify([account, listed])).not.toContain(
      "sk-bdd-openai-key",
    );
  });

  it("connectors.bdd-002 (3/4) shows an all-empty scope diff for the manual OpenAI account", async () => {
    const member = bdd.user();
    await connectOpenAi(member);

    await expect(
      connectors.readDefaultBuiltinScopeDiff(member, "openai"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });
  });

  it("connectors.bdd-002 (4/4) clears the default OpenAI connection after deletion", async () => {
    const member = bdd.user();
    await connectOpenAi(member);

    await connectors.deleteDefaultBuiltinConnectorAccount(member, "openai");
    const after = await connectors.requestBuiltinConnectorAccounts(
      member,
      "openai",
      [200],
    );
    expect(after.body.defaultConnection).toBeNull();
  });

  it("connectors.bdd-021 rejects credentialless manual auth across definition write boundaries", async () => {
    const admin = bdd.user();

    const literalCreate = await connectors.requestCreateCustomConnector(
      admin,
      literalOnlyHttpBody("Literal only"),
      [400],
    );
    expect(errorMessage(literalCreate.body)).toContain(LITERAL_ONLY_MESSAGE);

    const prefix = `https://api.${randomUUID()}.example.test/v1`;
    const headerInjections = [
      { name: "Authorization", valueTemplate: "Bearer {{secrets.api_key}}" },
    ];
    const valid = await connectors.createCustomConnector(admin, {
      displayName: "Valid manual",
      prefixTemplates: [prefix],
      fields: [
        { key: "api_key", label: "API key", kind: "secret", required: true },
      ],
      headerInjections,
      queryInjections: [],
    });
    await expect(
      connectors.listCustomConnectorAccounts(admin, valid.id),
    ).resolves.toStrictEqual([]);

    const literalUpdate = await connectors.requestUpdateCustomConnector(
      admin,
      valid.id,
      { ...literalOnlyHttpBody("Switched"), prefixTemplates: [prefix] },
      [400],
    );
    expect(errorMessage(literalUpdate.body)).toContain(LITERAL_ONLY_MESSAGE);

    const literalProposal = await connectors.requestSaveCustomConnectorProposal(
      admin,
      {
        proposal: { operation: "create", ...literalOnlyHttpBody("Proposal") },
        values: [],
      },
      [400],
    );
    expect(errorMessage(literalProposal.body)).toContain(LITERAL_ONLY_MESSAGE);

    await expect(
      connectors.readCustomConnector(admin, valid.id),
    ).resolves.toMatchObject({ displayName: "Valid manual", headerInjections });
  });

  it("connectors.bdd-022 (1/2) connects an optional-field manual connector only after an explicit values write", async () => {
    const admin = bdd.user();
    const connector = await createOptionalKeyConnector(admin);
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual([]);

    const connected = await connectors.setCustomConnectorValues(
      admin,
      connector.id,
      [],
    );
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toMatchObject([
      {
        id: connected.connectionId,
        isDefault: true,
        connectionStatus: "connected",
        configuredFieldKeys: [],
        missingRequiredFields: [],
      },
    ]);
    expect(Number.isNaN(Date.parse(connected.updatedAt))).toBeFalsy();
  });

  it("connectors.bdd-022 (2/2) makes the optional-field connector not ready again after the account is deleted", async () => {
    const admin = bdd.user();
    const connector = await createOptionalKeyConnector(admin);
    await connectors.setCustomConnectorValues(admin, connector.id, []);

    await connectors.deleteDefaultCustomConnectorAccount(admin, connector.id);
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-023 (1/2) connects no-auth HTTP and MCP definitions with credential-free accounts", async () => {
    const admin = bdd.user();
    bdd.acceptStorageWrites();
    const http = await connectors.createCustomConnector(
      admin,
      noAuthHttpBody(),
    );
    const mcp = await connectors.createCustomConnector(admin, {
      kind: "mcp",
      displayName: "Open MCP",
      endpoint: `https://mcp-${randomUUID()}.example.test/mcp`,
      transport: "streamable-http",
      authMode: "none",
      fields: [],
      headerInjections: [],
      queryInjections: [],
    });
    expect([http.authMode, mcp.authMode]).toStrictEqual(["none", "none"]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, http.id),
    ).resolves.toStrictEqual([]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, mcp.id),
    ).resolves.toStrictEqual([]);

    const httpConnected = await connectRegion(admin, http.id, "us");
    const mcpConnected = await connectors.setCustomConnectorValues(
      admin,
      mcp.id,
      [],
    );
    expect([httpConnected.authMode, mcpConnected.authMode]).toStrictEqual([
      "none",
      "none",
    ]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, http.id),
    ).resolves.toMatchObject([
      {
        id: httpConnected.connectionId,
        connectionStatus: "connected",
        configuredFieldKeys: ["region"],
        missingRequiredFields: [],
      },
    ]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, mcp.id),
    ).resolves.toMatchObject([
      {
        id: mcpConnected.connectionId,
        connectionStatus: "connected",
        configuredFieldKeys: [],
        missingRequiredFields: [],
      },
    ]);

    await connectRegion(admin, http.id, "eu", {
      intent: "reconnect",
      connectionId: httpConnected.connectionId,
    });
    await expect(
      connectors.listCustomConnectorAccounts(admin, http.id),
    ).resolves.toMatchObject([
      { id: httpConnected.connectionId, connectionStatus: "connected" },
    ]);
  });

  it("connectors.bdd-023 (2/2) leaves the no-auth account not ready after switching to manual and back", async () => {
    const admin = bdd.user();
    bdd.acceptStorageWrites();
    const body = noAuthHttpBody();
    const http = await connectors.createCustomConnector(admin, body);
    await connectRegion(admin, http.id, "us");

    const manual = await connectors.updateCustomConnector(admin, http.id, {
      ...body,
      authMode: "manual",
      fields: [
        ...body.fields,
        { key: "secret", label: "Secret", kind: "secret", required: true },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
      ],
    });
    expect(manual.storageVersion).toBe(2);
    await expect(connectedAccounts(admin, http.id)).resolves.toStrictEqual([]);

    const restored = await connectors.updateCustomConnector(
      admin,
      http.id,
      body,
    );
    expect(restored).toMatchObject({ authMode: "none", storageVersion: 3 });
    await expect(connectedAccounts(admin, http.id)).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-024 (1/2) uses exact reconnect semantics for an HTTP custom connector", async () => {
    await expect(
      expectExactReconnectSemantics(
        manualHttpCustomConnectorCreateBody({
          displayName: "Reconnect HTTP",
          prefixTemplates: [`https://api.${randomUUID()}.example.test/v1/`],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("connectors.bdd-024 (2/2) uses exact reconnect semantics for an MCP custom connector", async () => {
    await expect(
      expectExactReconnectSemantics(manualMcpBody("Reconnect MCP")),
    ).resolves.toBeUndefined();
  });

  it("connectors.bdd-049 (1/3) reports unavailable protected-resource metadata as a provider outage", async () => {
    await expect(
      startAgainstUnavailableProvider({ resourceMetadataStatus: 503 }),
    ).resolves.toMatchObject({ code: "MCP_OAUTH_PROVIDER_UNAVAILABLE" });
  });

  it("connectors.bdd-049 (2/3) reports a rate-limited client registration as a provider outage after one attempt", async () => {
    await expect(
      startAgainstUnavailableProvider({ dcrFailureStatus: 429 }),
    ).resolves.toStrictEqual({
      code: "MCP_OAUTH_PROVIDER_UNAVAILABLE",
      registrations: 1,
    });
  });

  it("connectors.bdd-049 (3/3) reports an unavailable client registration as a provider outage after one attempt", async () => {
    await expect(
      startAgainstUnavailableProvider({ dcrFailureStatus: 503 }),
    ).resolves.toStrictEqual({
      code: "MCP_OAUTH_PROVIDER_UNAVAILABLE",
      registrations: 1,
    });
  });

  it("connectors.bdd-056 rejects automatic MCP OAuth when the server offers no client registration", async () => {
    const admin = bdd.user();
    const provider = automaticProvider({
      registration: "none",
      authentication: "oauth",
    });
    const connector = await createAutomaticConnector(admin, provider.endpoint);

    const started = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [400],
    );
    expectApiError(started.body);
    expect(started.body.error).toMatchObject({
      code: "MCP_OAUTH_CLIENT_REGISTRATION_UNAVAILABLE",
      message:
        "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method.",
    });
  });

  it("connectors.bdd-064 (1/2) lets only admins create a manual HTTP connector and keeps it ready across an update", async () => {
    const admin = bdd.user();
    const member = memberOf(admin);
    bdd.acceptStorageWrites();
    const body = lifecycleBody();

    const memberCreate = await connectors.requestCreateCustomConnector(
      member,
      body,
      [403],
    );
    expect(errorCode(memberCreate.body)).toBe("FORBIDDEN");

    const created = await connectors.createCustomConnector(admin, body);
    await expect(connectors.listCustomConnectors(admin)).resolves.toMatchObject(
      [
        {
          id: created.id,
          slug: created.slug,
          displayName: "Lifecycle API",
          prefixTemplates: body.prefixTemplates,
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.secret}}",
            },
          ],
        },
      ],
    );

    await connectors.setCustomConnectorSecret(
      admin,
      created.id,
      "lifecycle-secret-one",
    );
    const connectedAccounts = await connectors.listCustomConnectorAccounts(
      admin,
      created.id,
    );
    expect(connectedAccounts).toMatchObject([
      { connectionStatus: "connected", missingRequiredFields: [] },
    ]);
    expect(
      JSON.stringify([
        connectedAccounts,
        await connectors.listCustomConnectors(admin),
      ]),
    ).not.toContain("lifecycle-secret-one");

    const firstUpdate = await updateLifecyclePrefix(admin, created.id, body, 2);
    expect(firstUpdate).toMatchObject({
      displayName: "Lifecycle API v2",
      prefixTemplates: [versionedPrefix(body, 2)],
    });
    await expect(
      connectors.listCustomConnectorAccounts(admin, created.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
  });

  it("connectors.bdd-064 (2/2) disconnects, reconnects and deletes an updated manual HTTP connector", async () => {
    const admin = bdd.user();
    const otherAdmin = bdd.user();
    bdd.acceptStorageWrites();
    const body = lifecycleBody();
    const created = await connectors.createCustomConnector(admin, body);
    await connectors.setCustomConnectorSecret(
      admin,
      created.id,
      "lifecycle-secret-one",
    );
    await updateLifecyclePrefix(admin, created.id, body, 2);
    const foreign = await connectors.createCustomConnector(
      otherAdmin,
      manualHttpCustomConnectorCreateBody({
        displayName: "Other organization API",
        prefixTemplates: [`https://api.${randomUUID()}.example.test/v1/`],
      }),
    );

    await expect(
      updateLifecyclePrefix(admin, created.id, body, 3),
    ).resolves.toMatchObject({ displayName: "Lifecycle API v3" });

    await connectors.deleteDefaultCustomConnectorAccount(admin, created.id);
    await expect(
      connectors.listCustomConnectorAccounts(admin, created.id),
    ).resolves.toStrictEqual([]);

    await connectors.setCustomConnectorSecret(
      admin,
      created.id,
      "lifecycle-secret-two",
    );
    await expect(
      connectors.listCustomConnectorAccounts(admin, created.id),
    ).resolves.toMatchObject([
      { connectionStatus: "connected", configuredFieldKeys: ["secret"] },
    ]);

    await connectors.deleteCustomConnector(admin, created.id);
    await expect(connectors.listCustomConnectors(admin)).resolves.toStrictEqual(
      [],
    );
    await expect(
      connectors.listCustomConnectors(otherAdmin),
    ).resolves.toMatchObject([{ id: foreign.id }]);
  });

  it("connectors.bdd-068 rejects a partial first connection without creating an account", async () => {
    const admin = bdd.user();
    const connector = await connectors.createCustomConnector(admin, {
      displayName: "Two fields",
      prefixTemplates: [`https://api.${randomUUID()}.example.test/v1`],
      fields: [
        { key: "api_key", label: "API key", kind: "secret", required: true },
        { key: "account", label: "Account", kind: "variable", required: true },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.api_key}}" },
      ],
      queryInjections: [
        { name: "account", valueTemplate: "{{variables.account}}" },
      ],
    });

    const response = await connectors.requestSetCustomConnectorValues(
      admin,
      connector.id,
      [{ key: "api_key", kind: "secret", value: "partial-api-key" }],
      [400],
    );
    expect(errorMessage(response.body)).toContain(
      "All required fields must be provided when connecting or restoring",
    );
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-072 saves a create proposal with values as a ready connector", async () => {
    const admin = bdd.user();
    const body = subdomainProposal([
      { key: "api_key", kind: "secret", value: "proposal-secret-value" },
      { key: "subdomain", kind: "variable", value: "acme" },
    ]);

    const saved = await connectors.saveCustomConnectorProposal(admin, body);
    expect(saved.connector).toMatchObject({
      displayName: "Tenant API",
      prefixTemplates: body.proposal.prefixTemplates,
      headerInjections: body.proposal.headerInjections,
    });
    const accounts = await connectors.listCustomConnectorAccounts(
      admin,
      saved.connector.id,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: saved.connectionId,
      connectionStatus: "connected",
      missingRequiredFields: [],
    });
    expect([...(accounts[0]?.configuredFieldKeys ?? [])].sort()).toStrictEqual([
      "api_key",
      "subdomain",
    ]);

    const listed = await connectors.listCustomConnectors(admin);
    expect(
      listed.map((connector) => {
        return connector.id;
      }),
    ).toStrictEqual([saved.connector.id]);
    expect(JSON.stringify(listed)).not.toContain("proposal-secret-value");
    expect(JSON.stringify(accounts)).not.toContain("proposal-secret-value");
  });

  it("connectors.bdd-073 saves proposals without values according to required fields", async () => {
    const admin = bdd.user();
    bdd.acceptStorageWrites();
    const fields = (required: boolean) => {
      return [
        { key: "api_key", label: "API key", kind: "secret" as const, required },
      ];
    };
    const proposal = (displayName: string, required: boolean) => {
      return {
        proposal: {
          operation: "create" as const,
          displayName,
          prefixTemplates: [`https://api.${randomUUID()}.example.test/v1`],
          fields: fields(required),
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        },
        values: [],
      };
    };

    const requiredSaved = await connectors.saveCustomConnectorProposal(
      admin,
      proposal("Required key", true),
    );
    const requiredAccounts = await connectors.listCustomConnectorAccounts(
      admin,
      requiredSaved.connector.id,
    );
    expect(
      requiredAccounts.filter((account) => {
        return account.connectionStatus === "connected";
      }),
    ).toStrictEqual([]);

    const optionalSaved = await connectors.saveCustomConnectorProposal(
      admin,
      proposal("Optional key", false),
    );
    const optionalAccounts = await connectors.listCustomConnectorAccounts(
      admin,
      optionalSaved.connector.id,
    );
    expect(optionalAccounts).toHaveLength(1);
    expect(optionalAccounts[0]).toMatchObject({
      id: optionalSaved.connectionId,
      isDefault: true,
      connectionStatus: "connected",
      configuredFieldKeys: [],
      missingRequiredFields: [],
    });
  });

  it("connectors.bdd-074 rejects an unsafe host template value without saving the connector", async () => {
    const admin = bdd.user();
    const response = await connectors.requestSaveCustomConnectorProposal(
      admin,
      subdomainProposal([
        { key: "api_key", kind: "secret", value: "unsafe-host-secret" },
        { key: "subdomain", kind: "variable", value: "evil.test/path" },
      ]),
      [400],
    );
    expect(errorMessage(response.body)).toContain(
      "not safe in custom connector host templates",
    );
    await expect(connectors.listCustomConnectors(admin)).resolves.toStrictEqual(
      [],
    );
  });

  it("connectors.bdd-078 disconnects a variable-only proposal connector through connector accounts", async () => {
    const admin = bdd.user();
    const saved = await connectors.saveCustomConnectorProposal(admin, {
      proposal: {
        operation: "create",
        displayName: "Variable only",
        prefixTemplates: [
          "https://{{variables.subdomain}}.tenant.example.test/",
        ],
        fields: [
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "variable",
            required: true,
          },
        ],
        headerInjections: [],
        queryInjections: [
          { name: "tenant", valueTemplate: "{{variables.subdomain}}" },
        ],
      },
      values: [{ key: "subdomain", kind: "variable", value: "acme" }],
    });
    expect(saved.connector).toMatchObject({
      headerInjections: [],
      queryInjections: [
        { name: "tenant", valueTemplate: "{{variables.subdomain}}" },
      ],
    });
    const connectionId = saved.connectionId;
    if (connectionId === undefined) {
      throw new Error("Expected the proposal to connect a default account");
    }
    await expect(
      connectors.listCustomConnectorAccounts(admin, saved.connector.id),
    ).resolves.toMatchObject([
      {
        id: connectionId,
        connectionStatus: "connected",
        configuredFieldKeys: ["subdomain"],
        missingRequiredFields: [],
      },
    ]);

    await connectors.deleteCustomConnectorAccount(
      admin,
      saved.connector.id,
      connectionId,
    );

    await expect(
      connectors.listCustomConnectorAccounts(admin, saved.connector.id),
    ).resolves.toStrictEqual([]);
    const listed = await connectors.listCustomConnectors(admin);
    expect(
      listed.map((connector) => {
        return connector.id;
      }),
    ).toStrictEqual([saved.connector.id]);
  });

  it("connectors.bdd-080 derives distinct host-based slugs for manual HTTP prefixes", async () => {
    const admin = bdd.user();
    const host = "bdd-slug.example.test";
    const create = async (prefix: string) => {
      return await connectors.createCustomConnector(
        admin,
        manualHttpCustomConnectorCreateBody({
          displayName: "Slug API",
          prefixTemplates: [prefix],
        }),
      );
    };

    const first = await create(`https://api.${host}/v1`);
    const firstSlugPrefix = "_api-bdd-slug-example-test-";
    expect(first.slug.startsWith(firstSlugPrefix)).toBeTruthy();
    expect(first.slug).toHaveLength(firstSlugPrefix.length + 6);
    expect(first.prefixTemplates).toStrictEqual([`https://api.${host}/v1`]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, first.id),
    ).resolves.toStrictEqual([]);

    const duplicate = await create(`https://api.${host}/v1`);
    expect(duplicate.id).not.toBe(first.id);
    expect(duplicate.slug).not.toBe(first.slug);
    expect(duplicate.prefixTemplates).toStrictEqual([`https://api.${host}/v1`]);

    const wildcard = await create(`https://*.${host}/v1`);
    expect(wildcard.slug.startsWith("_bdd-slug-example-test-")).toBeTruthy();
    expect(wildcard.prefixTemplates).toStrictEqual([`https://*.${host}/v1`]);

    const github = await create("https://api.github.com/v3/");
    expect(github.prefixTemplates).toStrictEqual([
      "https://api.github.com/v3/",
    ]);
    const trailingDot = await create("https://api.github.com./v3/");
    expect(trailingDot.id).not.toBe(github.id);
    expect(trailingDot.slug).not.toBe(github.slug);

    const ids = [
      first.id,
      duplicate.id,
      wildcard.id,
      github.id,
      trailingDot.id,
    ];
    const listed = await connectors.listCustomConnectors(admin);
    expect(
      listed
        .map((connector) => {
          return connector.id;
        })
        .sort(),
    ).toStrictEqual([...ids].sort());

    for (const id of ids) {
      await connectors.deleteCustomConnector(admin, id);
    }
    await expect(connectors.listCustomConnectors(admin)).resolves.toStrictEqual(
      [],
    );
  });

  it("connectors.bdd-082 (1/3) rejects literal-only MCP auth and connects a manual MCP connector only after its secret", async () => {
    const admin = bdd.user();
    bdd.acceptStorageWrites();
    const literalOnly = await connectors.requestCreateCustomConnector(
      admin,
      {
        ...manualMcpBody("Literal MCP"),
        fields: [],
        headerInjections: [{ name: "X-Public-Mode", valueTemplate: "public" }],
      },
      [400],
    );
    expect(errorMessage(literalOnly.body)).toContain(LITERAL_ONLY_MESSAGE);

    const body = manualMcpBody("Manual MCP");
    const created = await connectors.createCustomConnector(admin, body);
    expect(created).toMatchObject({
      kind: "mcp",
      endpoint: body.endpoint,
      transport: "streamable-http",
      prefixTemplates: [],
      storageVersion: 1,
    });
    expect(created.permissionBundleRef ?? null).toBeNull();
    await expect(
      connectors.listCustomConnectorAccounts(admin, created.id),
    ).resolves.toStrictEqual([]);

    await connectors.setCustomConnectorSecret(
      admin,
      created.id,
      "manual-mcp-secret",
    );
    const accounts = await connectors.listCustomConnectorAccounts(
      admin,
      created.id,
    );
    expect(accounts).toMatchObject([{ connectionStatus: "connected" }]);
    expect(
      JSON.stringify([accounts, await connectors.listCustomConnectors(admin)]),
    ).not.toContain("manual-mcp-secret");
  });

  it("connectors.bdd-082 (2/3) moves a manual MCP endpoint and refuses converting it to HTTP", async () => {
    const admin = bdd.user();
    const { body, created } = await connectedManualMcp(admin);

    const { moved, movedEndpoint } = await moveMcpEndpoint(
      admin,
      created.id,
      body,
    );
    expect(moved).toMatchObject({
      id: created.id,
      endpoint: movedEndpoint,
      storageVersion: 1,
    });
    await expect(
      connectors.listCustomConnectorAccounts(admin, created.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);

    const converted = await connectors.requestUpdateCustomConnector(
      admin,
      created.id,
      {
        kind: "http",
        displayName: "Manual MCP",
        prefixTemplates: [`https://api.${randomUUID()}.example.test/v1/`],
        fields: body.fields,
        headerInjections: body.headerInjections,
        queryInjections: [],
      },
      [400],
    );
    expect(errorMessage(converted.body)).toContain(
      "Custom connector protocol kind cannot be changed",
    );
    await expect(
      connectors.readCustomConnector(admin, created.id),
    ).resolves.toMatchObject({ kind: "mcp", endpoint: movedEndpoint });
  });

  it("connectors.bdd-082 (3/3) renames a moved manual MCP connector and disconnects it", async () => {
    const admin = bdd.user();
    const { body, created } = await connectedManualMcp(admin);
    const { movedEndpoint } = await moveMcpEndpoint(admin, created.id, body);

    const renamed = await connectors.updateCustomConnector(admin, created.id, {
      ...body,
      displayName: "Renamed MCP",
      endpoint: movedEndpoint,
    });
    expect(renamed).toMatchObject({
      displayName: "Renamed MCP",
      endpoint: movedEndpoint,
      storageVersion: 1,
    });
    expect(JSON.stringify(renamed)).not.toContain("manual-mcp-secret");

    await connectors.deleteDefaultCustomConnectorAccount(admin, created.id);
    const remaining = await connectors.listCustomConnectorAccounts(
      admin,
      created.id,
    );
    expect(
      remaining.filter((account) => {
        return account.connectionStatus === "connected";
      }),
    ).toStrictEqual([]);
  });

  it("connectors.bdd-083 (1/3) rejects unsafe manual MCP endpoints", async () => {
    const admin = bdd.user();
    bdd.acceptStorageWrites();
    for (const endpoint of [
      "http://plain.example.test/mcp",
      "https://user:pass@userinfo.example.test/mcp",
      "https://fragment.example.test/mcp#section",
      "https://{{variables.host}}.example.test/mcp",
      "https://127.0.0.1/mcp",
      "https://[::1]/mcp",
      "https://port.example.test:99999/mcp",
    ]) {
      const rejected = await connectors.requestCreateCustomConnector(
        admin,
        guardedMcpBody(endpoint),
        [400],
      );
      expect(rejected.status).toBe(400);
    }
  });

  it("connectors.bdd-083 (2/3) rejects protected MCP headers", async () => {
    const admin = bdd.user();
    bdd.acceptStorageWrites();
    for (const header of [
      "Host",
      "Content-Type",
      "Last-Event-ID",
      "MCP-Protocol-Version",
      "X-Okou-Connector-Intent",
    ]) {
      const rejected = await connectors.requestCreateCustomConnector(
        admin,
        guardedMcpBody("https://headers.example.test/mcp", header),
        [400],
      );
      expect(errorMessage(rejected.body)).toContain("protected header");
    }
  });

  it("connectors.bdd-083 (3/3) accepts shared, root and query MCP endpoints and keeps the protocol kind", async () => {
    const admin = bdd.user();
    bdd.acceptStorageWrites();
    const sharedEndpoint = `https://shared-${randomUUID()}.example.test/mcp`;
    const firstShared = await connectors.createCustomConnector(
      admin,
      guardedMcpBody(sharedEndpoint),
    );
    const secondShared = await connectors.createCustomConnector(
      admin,
      guardedMcpBody(sharedEndpoint),
    );
    expect(secondShared.id).not.toBe(firstShared.id);

    const root = await connectors.createCustomConnector(
      admin,
      guardedMcpBody("https://root-mcp.example.test/"),
    );
    const rootSlugPrefix = "_root-mcp-example-test-";
    expect(root.slug.startsWith(rootSlugPrefix)).toBeTruthy();
    expect(root.slug.slice(rootSlugPrefix.length)).toMatch(/^[0-9a-f]{6}$/);

    const queryEndpoint = `https://query-${randomUUID()}.example.test/mcp?tenant=acme&mode=full`;
    const withQuery = await connectors.createCustomConnector(
      admin,
      guardedMcpBody(queryEndpoint),
    );
    expect(withQuery).toMatchObject({
      kind: "mcp",
      endpoint: queryEndpoint,
      authMode: "manual",
    });
    await expect(
      connectors.listCustomConnectorAccounts(admin, withQuery.id),
    ).resolves.toStrictEqual([]);

    const httpBody = manualHttpCustomConnectorCreateBody({
      displayName: "HTTP only",
      prefixTemplates: [`https://api.${randomUUID()}.example.test/v1/`],
    });
    const httpConnector = await connectors.createCustomConnector(
      admin,
      httpBody,
    );
    const toMcp = await connectors.requestUpdateCustomConnector(
      admin,
      httpConnector.id,
      {
        ...manualMcpBody("HTTP only"),
        fields: httpBody.fields,
        headerInjections: httpBody.headerInjections,
      },
      [400],
    );
    expect(errorMessage(toMcp.body)).toContain(
      "Custom connector protocol kind cannot be changed",
    );
  });

  it("connectors.bdd-090 limits custom connector deletion to admins of the owning organization", async () => {
    const admin = bdd.user();
    const member = memberOf(admin);
    const otherAdmin = bdd.user();
    const original = await connectors.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "Original",
        prefixTemplates: [`https://api.${randomUUID()}.example.test/v1`],
      }),
    );
    const foreign = await connectors.createCustomConnector(
      otherAdmin,
      manualHttpCustomConnectorCreateBody({
        displayName: "OtherOrg",
        prefixTemplates: [`https://api.${randomUUID()}.example.test/v1`],
      }),
    );

    const memberDelete = await connectors.requestDeleteCustomConnector(
      member,
      original.id,
      [403],
    );
    expect(errorMessage(memberDelete.body)).toContain(
      "Only org admins can delete custom connectors",
    );
    await expect(
      connectors.readCustomConnector(admin, original.id),
    ).resolves.toMatchObject({ displayName: "Original" });

    const crossOrgDelete = await connectors.requestDeleteCustomConnector(
      admin,
      foreign.id,
      [404],
    );
    expect(errorCode(crossOrgDelete.body)).toBe("NOT_FOUND");
    await expect(
      connectors.readCustomConnector(otherAdmin, foreign.id),
    ).resolves.toMatchObject({ displayName: "OtherOrg" });

    await connectors.setCustomConnectorSecret(
      otherAdmin,
      foreign.id,
      "other-org-secret",
    );
    await connectors.deleteCustomConnector(admin, original.id);
    await connectors.deleteCustomConnector(otherAdmin, foreign.id);
    await expect(
      connectors.listCustomConnectors(otherAdmin),
    ).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-091 (1/2) keeps member and admin secrets on separate accounts without exposing them", async () => {
    const { admin, member, shared } = await sharedSecretsGiven();

    const unknown = await connectors.requestSetCustomConnectorSecret(
      admin,
      randomUUID(),
      "unknown-connector-secret",
      [404],
    );
    expect(errorMessage(unknown.body)).toContain("Custom connector not found");
    await expect(
      connectors.listCustomConnectorAccounts(member, shared.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, shared.id),
    ).resolves.toStrictEqual([]);

    const adminConnectionId = await connectAndRotateAdminSecret(
      admin,
      shared.id,
    );
    const adminAccounts = await connectors.listCustomConnectorAccounts(
      admin,
      shared.id,
    );
    expect(adminAccounts).toMatchObject([
      { id: adminConnectionId, connectionStatus: "connected" },
    ]);
    const visible = JSON.stringify([
      adminAccounts,
      await connectors.listCustomConnectors(admin),
      await connectors.listCustomConnectorAccounts(member, shared.id),
    ]);
    for (const secret of [
      "member-secret-value",
      "admin-secret-value",
      "admin-rotated-secret",
    ]) {
      expect(visible).not.toContain(secret);
    }
  });

  it("connectors.bdd-091 (2/2) disconnects only the admin's account and removes deleted connectors per organization", async () => {
    const { admin, member, adminElsewhere, shared } =
      await sharedSecretsGiven();
    await connectAndRotateAdminSecret(admin, shared.id);
    const elsewhere = await connectors.createCustomConnector(
      adminElsewhere,
      manualHttpCustomConnectorCreateBody({
        displayName: "Elsewhere API",
        prefixTemplates: [`https://api.${randomUUID()}.example.test/v1/`],
      }),
    );

    await connectors.setCustomConnectorSecret(
      adminElsewhere,
      elsewhere.id,
      "elsewhere-secret-value",
    );
    await expect(
      connectors.listCustomConnectorAccounts(adminElsewhere, elsewhere.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);

    await connectors.deleteDefaultCustomConnectorAccount(admin, shared.id);
    await expect(
      connectors.listCustomConnectorAccounts(admin, shared.id),
    ).resolves.toStrictEqual([]);
    await expect(
      connectors.listCustomConnectorAccounts(member, shared.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
    await expect(
      connectors.listCustomConnectorAccounts(adminElsewhere, elsewhere.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);

    await connectors.deleteCustomConnector(admin, shared.id);
    await connectors.deleteCustomConnector(adminElsewhere, elsewhere.id);
    await expect(connectors.listCustomConnectors(admin)).resolves.toStrictEqual(
      [],
    );
    await expect(
      connectors.listCustomConnectors(adminElsewhere),
    ).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-099 (1/2) completes a test OAuth device session with the api method", async () => {
    const member = bdd.user();
    const first = await connectApiDeviceSession(member);
    expect(first.account.authMethod).toBe("api");
  });

  it("connectors.bdd-099 (2/2) reconnects the api device connection through the oauth device method", async () => {
    const member = bdd.user();
    const first = await connectApiDeviceSession(member);

    const reconnect = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: first.connectionId },
    );
    const reconnectPoll = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      reconnect.sessionId,
      reconnect.sessionToken,
    );
    if (reconnectPoll.status !== "complete") {
      throw new Error(
        `Expected a completed reconnect, got ${reconnectPoll.status}`,
      );
    }
    expect(reconnectPoll.account.authMethod).toBe("oauth");
    await expect(
      connectors.readDefaultBuiltinAccount(member, "test-oauth-device"),
    ).resolves.toMatchObject({ id: first.connectionId, authMethod: "oauth" });
  });

  it("connectors.bdd-008 (1/2) adds a non-default sibling account through a second device session", async () => {
    const member = bdd.user();
    const { first, sibling } = await addTwoDeviceAccounts(member);

    expect(sibling.connectionId).not.toBe(first.connectionId);
    const accounts = await connectors.listBuiltinConnectorAccounts(
      member,
      "test-oauth-device",
    );
    expect(
      accounts.map((account) => {
        return { id: account.id, isDefault: account.isDefault };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        { id: first.connectionId, isDefault: true },
        { id: sibling.connectionId, isDefault: false },
      ]),
    );
  });

  it("connectors.bdd-008 (2/2) re-polls the sibling device session to the same sibling account", async () => {
    const member = bdd.user();
    const { sibling } = await addTwoDeviceAccounts(member);

    const repoll = await connectors.requestDeviceAuthPoll(
      member,
      "test-oauth-device",
      sibling.started.sessionId,
      sibling.started.sessionToken,
      [200],
    );
    expect(repoll.body).toMatchObject({
      status: "complete",
      connectionId: sibling.connectionId,
    });
  });

  it("connectors.bdd-003 uses App callbacks for enabled connectors while returning structured callback results", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockGitHubConnectorOAuth();
    const firstMember = bdd.user({ orgRole: "org:member" });
    const secondMember = bdd.user({ orgRole: "org:member" });

    const firstStart = await connectors.requestOauthStart(
      firstMember,
      "github",
      "oauth",
      { statuses: [200], callbackTarget: "app" },
    );
    if (!("authorizationUrl" in firstStart.body)) {
      throw new Error("Expected authorizationUrl for first member");
    }
    const firstAuthUrl = new URL(firstStart.body.authorizationUrl);
    const redirectUri = firstAuthUrl.searchParams.get("redirect_uri");
    if (!redirectUri) {
      throw new Error("Expected redirect_uri in authorization URL");
    }
    expect(new URL(redirectUri).pathname).toBe("/connectors/github/callback");

    const successCallback = await connectors.completeOauthCallbackResult(
      "github",
      {
        code: "gh-success-code",
        state: oauthStateFromUrl(firstStart.body.authorizationUrl),
      },
    );
    expect(successCallback.body).toStrictEqual({
      status: "success",
      username: "bdd-github-user",
    });
    expect(successCallback.headers.get("cache-control")).toBe("no-store");
    expectClearedOAuthCookies(successCallback.headers);

    const firstAccount = await connectors.readDefaultBuiltinAccount(
      firstMember,
      "github",
    );
    expect(firstAccount).toMatchObject({
      connectionStatus: "connected",
      externalUsername: "bdd-github-user",
    });

    const secondStart = await connectors.requestOauthStart(
      secondMember,
      "github",
      "oauth",
      { statuses: [200], callbackTarget: "app" },
    );
    if (!("authorizationUrl" in secondStart.body)) {
      throw new Error("Expected authorizationUrl for second member");
    }
    const deniedCallback = await connectors.completeOauthCallbackResult(
      "github",
      {
        state: oauthStateFromUrl(secondStart.body.authorizationUrl),
        error: "access_denied",
        error_description: "Provider denied access",
      },
    );
    expect(deniedCallback.body).toStrictEqual({
      status: "error",
      message: "Provider denied access",
    });
    await expect(
      connectors.listBuiltinConnectorAccounts(secondMember, "github"),
    ).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-004 starts GitHub OAuth, completes the callback, rejects replay visibly, and keeps safe connector state", async () => {
    mockGitHubConnectorOAuth();
    const firstMember = bdd.user({ orgRole: "org:member" });
    const secondMember = bdd.user({ orgRole: "org:member" });

    const started = await connectors.startOauth(firstMember, "github", "oauth");
    const authUrl = new URL(started.authorizationUrl);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authUrl.searchParams.get("client_id")).toBe("github-client-id");

    const state = oauthStateFromUrl(started.authorizationUrl);
    const completed = await connectors.completeOauthCallback("github", {
      code: "gh-code-1",
      state,
    });
    expect(redirectLocationUrl(completed.headers).pathname).toBe(
      "/connector/success",
    );

    const account = await connectors.readDefaultBuiltinAccount(
      firstMember,
      "github",
    );
    expect(account).toMatchObject({
      authMethod: "oauth",
      connectionStatus: "connected",
      externalId: "42",
      externalUsername: "bdd-github-user",
      externalEmail: "bdd-github@example.test",
    });
    expect(account.oauthScopes).toStrictEqual(
      expect.arrayContaining(["repo", "project", "workflow"]),
    );
    expect(JSON.stringify(account)).not.toContain("github-access-gh-code-1");

    const scopeDiff = await connectors.readDefaultBuiltinScopeDiff(
      firstMember,
      "github",
    );
    expect(scopeDiff.addedScopes).toStrictEqual([]);
    expect(scopeDiff.removedScopes).toStrictEqual([]);

    const replay = await connectors.completeOauthCallback("github", {
      code: "gh-code-2",
      state,
    });
    expect(redirectLocationUrl(replay.headers).pathname).toBe(
      "/connector/error",
    );
    const afterReplay = await connectors.readDefaultBuiltinAccount(
      firstMember,
      "github",
    );
    expect(afterReplay).toMatchObject({
      id: account.id,
      externalUsername: "bdd-github-user",
    });

    const secondStart = await connectors.startOauth(
      secondMember,
      "github",
      "oauth",
    );
    const denied = await connectors.completeOauthCallback("github", {
      state: oauthStateFromUrl(secondStart.authorizationUrl),
      error: "access_denied",
    });
    expect(redirectLocationUrl(denied.headers).pathname).toBe(
      "/connector/error",
    );
    await expect(
      connectors.listBuiltinConnectorAccounts(secondMember, "github"),
    ).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-005 (1/2) reconnects the exact GitHub account and rejects mismatched identities", async () => {
    mockGitHubConnectorOAuth({ userId: 42, login: "bdd-github-user" });
    const member = bdd.user({ orgRole: "org:member" });

    const initialStart = await connectors.startOauth(member, "github", "oauth");
    await connectors.completeOauthCallback("github", {
      code: "gh-initial",
      state: oauthStateFromUrl(initialStart.authorizationUrl),
    });
    const original = await connectors.readDefaultBuiltinAccount(
      member,
      "github",
    );

    const sameReconnect = await connectors.startOauth(
      member,
      "github",
      "oauth",
      { intent: "reconnect", connectionId: original.id },
    );
    const sameCallback = await connectors.completeOauthCallback("github", {
      code: "gh-same-reconnect",
      state: oauthStateFromUrl(sameReconnect.authorizationUrl),
    });
    expect(redirectLocationUrl(sameCallback.headers).pathname).toBe(
      "/connector/success",
    );
    const afterSameReconnect = await connectors.readDefaultBuiltinAccount(
      member,
      "github",
    );
    expect(afterSameReconnect.id).toBe(original.id);

    mockGitHubConnectorOAuth({ userId: 99, login: "other-github-user" });
    const mismatchedReconnect = await connectors.startOauth(
      member,
      "github",
      "oauth",
      { intent: "reconnect", connectionId: original.id },
    );
    const mismatchCallback = await connectors.completeOauthCallback("github", {
      code: "gh-mismatch",
      state: oauthStateFromUrl(mismatchedReconnect.authorizationUrl),
    });
    const mismatchUrl = redirectLocationUrl(mismatchCallback.headers);
    expect(mismatchUrl.pathname).toBe("/connector/error");
    expect(mismatchUrl.searchParams.get("connectorSlug")).toBe("github");
    expect(mismatchUrl.searchParams.get("message")).toContain(
      "Authorized account does not match the connector account",
    );

    const afterMismatch = await connectors.readDefaultBuiltinAccount(
      member,
      "github",
    );
    expect(afterMismatch).toMatchObject({
      id: original.id,
      externalId: "42",
    });
  });

  it("connectors.bdd-005 (2/2) adds a non-default sibling GitHub account through OAuth", async () => {
    mockGitHubConnectorOAuth({ userId: 42, login: "bdd-github-user" });
    const member = bdd.user({ orgRole: "org:member" });

    const initialStart = await connectors.startOauth(member, "github", "oauth");
    await connectors.completeOauthCallback("github", {
      code: "gh-initial",
      state: oauthStateFromUrl(initialStart.authorizationUrl),
    });

    mockGitHubConnectorOAuth({ userId: 99, login: "other-github-user" });
    const siblingStart = await connectors.startOauth(
      member,
      "github",
      "oauth",
      { intent: "add", displayName: "Personal" },
    );
    const siblingCallback = await connectors.completeOauthCallback("github", {
      code: "gh-sibling",
      state: oauthStateFromUrl(siblingStart.authorizationUrl),
    });
    expect(redirectLocationUrl(siblingCallback.headers).pathname).toBe(
      "/connector/success",
    );

    const accounts = await connectors.listBuiltinConnectorAccounts(
      member,
      "github",
    );
    expect(accounts).toHaveLength(2);
    expect(
      accounts.find((candidate) => {
        return candidate.displayName === "Personal";
      }),
    ).toMatchObject({
      isDefault: false,
      displayName: "Personal",
    });
  });

  it("connectors.bdd-006 persists the callback-selected Datadog site through the public OAuth flow", async () => {
    const provider = mockDatadogConnectorOAuth();
    const member = bdd.user({ orgRole: "org:member" });

    const started = await connectors.startOauth(member, "datadog", "oauth");
    const authUrl = new URL(started.authorizationUrl);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const callback = await connectors.completeOauthCallback("datadog", {
      code: "dd-auth-code",
      state: oauthStateFromUrl(started.authorizationUrl),
      domain: "us3.datadoghq.com",
    });
    expect(redirectLocationUrl(callback.headers).pathname).toBe(
      "/connector/success",
    );

    const [tokenBody] = provider.tokenBodies;
    if (!tokenBody) {
      throw new Error("Expected Datadog token exchange body");
    }
    expect(tokenBody.get("code")).toBe("dd-auth-code");
    expect(
      (tokenBody.get("code_verifier") ?? "").length,
    ).toBeGreaterThanOrEqual(43);

    const account = await connectors.readDefaultBuiltinAccount(
      member,
      "datadog",
    );
    expect(account).toMatchObject({
      authMethod: "oauth",
      connectionStatus: "connected",
      externalId: "us3.datadoghq.com",
      externalUsername: "us3.datadoghq.com",
    });
    expect(account.oauthScopes).toStrictEqual(
      expect.arrayContaining(["dashboards_read", "logs_read_index_data"]),
    );
    expect(JSON.stringify(account)).not.toContain("bdd-datadog-access-token");
    expect(JSON.stringify(account)).not.toContain("bdd-datadog-refresh-token");

    const scopeDiff = await connectors.readDefaultBuiltinScopeDiff(
      member,
      "datadog",
    );
    expect(scopeDiff.currentScopes).toStrictEqual(
      expect.arrayContaining([...DATADOG_READ_SCOPES]),
    );
    expect(scopeDiff.storedScopes).toStrictEqual(
      expect.arrayContaining([...DATADOG_READ_SCOPES]),
    );
    expect(scopeDiff.currentScopes).toHaveLength(7);
    expect(scopeDiff.storedScopes).toHaveLength(7);
    expect(scopeDiff.addedScopes).toStrictEqual([]);
    expect(scopeDiff.removedScopes).toStrictEqual([]);

    const catalogStatus = await readConnectorCatalogStatus(member);
    expect(
      catalogStatus.connectors.some((entry) => {
        return entry.slug === "datadog";
      }),
    ).toBeTruthy();
  });

  it("connectors.bdd-007 starts and completes a device authorization session, with state visible through connector APIs", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });
    await connectors.updateFeatureSwitches(member, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const search = await connectors.searchConnectors(
      member,
      "test-oauth-device",
    );
    const listed = search.connectors.find((entry) => {
      return entry.slug === "test-oauth-device";
    });
    expect(listed?.authMethods).toStrictEqual(
      expect.arrayContaining(["oauth", "api"]),
    );

    const firstProvider = mockTestOAuthDeviceConnectorProvider({
      tokenScope: "read provider-added",
    });
    const started = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "add" },
    );
    expect(started).toMatchObject({
      status: "pending",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
    });
    expect(firstProvider.deviceCodeBodies[0]?.get("scope")).toBe("read");

    const peerPoll = await connectors.requestDeviceAuthPoll(
      peer,
      "test-oauth-device",
      started.sessionId,
      started.sessionToken,
      [404],
    );
    expect(errorCode(peerPoll.body)).toBe("NOT_FOUND");

    const completed = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      started.sessionId,
      started.sessionToken,
    );
    if (completed.status !== "complete") {
      throw new Error(`Expected complete poll, got ${completed.status}`);
    }
    expect(completed.account).toMatchObject({
      authMethod: "oauth",
      connectionStatus: "connected",
      oauthScopes: ["read", "provider-added"],
    });
    await expect(
      connectors.readDefaultBuiltinAccount(member, "test-oauth-device"),
    ).resolves.toMatchObject({ id: completed.connectionId });
    const builtinList = await connectors.listBuiltinConnectors(member);
    expect(
      builtinList.connectors.map((entry) => {
        return entry.id;
      }),
    ).toContain(completed.connectionId);

    mockTestOAuthDeviceConnectorProvider({ tokenScope: "" });
    const reconnect = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: completed.connectionId },
    );
    const reconnected = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      reconnect.sessionId,
      reconnect.sessionToken,
    );
    if (reconnected.status !== "complete") {
      throw new Error(`Expected reconnect complete, got ${reconnected.status}`);
    }
    expect(reconnected.connectionId).toBe(completed.connectionId);
    expect(reconnected.account.oauthScopes).toStrictEqual([]);

    const deletedReconnect = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: completed.connectionId },
    );
    await connectors.deleteBuiltinConnectorAccount(
      member,
      "test-oauth-device",
      completed.connectionId,
    );
    const afterDeletePoll = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      deletedReconnect.sessionId,
      deletedReconnect.sessionToken,
    );
    expect(afterDeletePoll).toMatchObject({
      status: "error",
      errorCode: "connector_account_rejected",
      errorMessage: "Connector account not found",
    });
  });

  it("connectors.bdd-009 starts and completes the Stripe CLI device authorization method", async () => {
    const startedAt = now();
    mockNow(startedAt);
    const stripe = mockStripeCliDashboardAuth();
    const member = bdd.user({ orgRole: "org:member" });

    const session = await connectors.startDeviceAuth(member, "stripe", "cli", {
      mode: "live",
    });
    expect(session).toMatchObject({
      status: "pending",
      userCode: "STRIPE-CLI",
      verificationUri:
        "https://dashboard.stripe.com/stripecli/confirm_auth?code=STRIPE-CLI",
      verificationUriComplete:
        "https://dashboard.stripe.com/stripecli/confirm_auth?code=STRIPE-CLI",
      expiresIn: 600,
      interval: 1,
    });
    expect(stripe.startBodies[0]?.get("client_version")).toBe("1.42.1");
    expect(stripe.startBodies[0]?.get("device_name")).toBe(
      "vm0-stripe-connector",
    );

    mockNow(startedAt + 2000);
    const polled = await connectors.pollDeviceAuth(
      member,
      "stripe",
      session.sessionId,
      session.sessionToken,
    );
    if (polled.status !== "complete") {
      throw new Error(
        `Expected complete Stripe CLI poll, got ${polled.status}`,
      );
    }
    expect(polled.account).toMatchObject({
      authMethod: "cli",
      connectionStatus: "connected",
      externalId: "acct_bdd",
      externalUsername: "BDD Stripe",
      externalEmail: null,
      oauthScopes: [],
    });
    expect(JSON.stringify(polled.account)).not.toContain("rk_live_api456");
    expect(JSON.stringify(polled.account)).not.toContain("rk_test_api123");

    const listed = await connectors.listBuiltinConnectors(member);
    expect(
      listed.connectors.map((entry) => {
        return entry.id;
      }),
    ).toContain(polled.connectionId);
  });

  it("connectors.bdd-011 supersedes, completes, and idempotently re-reads device authorization sessions per auth method", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await connectors.updateFeatureSwitches(member, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const provider = mockTestOAuthDeviceConnectorProvider({
      tokenScope: "read granted",
    });

    await connectors.startDeviceAuth(member, "test-oauth-device", "api", {
      environment: "live",
    });
    const apiDefault = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "api",
    );
    expect(provider.deviceCodeBodies[0]?.get("mode")).toBe("live");
    expect(provider.deviceCodeBodies[1]?.get("mode")).toBe("test");
    expect(provider.deviceCodeBodies[0]?.get("client_id")).toBeTruthy();
    expect(provider.deviceCodeBodies[1]?.get("client_id")).toBe(
      provider.deviceCodeBodies[0]?.get("client_id"),
    );

    const firstOauth = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
    );
    expect(firstOauth).toMatchObject({
      status: "pending",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
      verificationUriComplete:
        "https://oauth-device.test/device?user_code=TEST-DEVICE",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(firstOauth)).not.toContain("test-device:");

    const secondOauth = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
    );

    const superseded = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      firstOauth.sessionId,
      firstOauth.sessionToken,
    );
    expect(superseded).toMatchObject({
      status: "error",
      errorCode: "session_superseded",
    });

    const apiComplete = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      apiDefault.sessionId,
      apiDefault.sessionToken,
    );
    if (apiComplete.status !== "complete") {
      throw new Error(`Expected api complete, got ${apiComplete.status}`);
    }
    expect(apiComplete.account.authMethod).toBe("api");
    expect(provider.tokenBodies.at(-1)?.get("device_code")).toContain(":test");

    await connectors.deleteDefaultBuiltinConnectorAccount(
      member,
      "test-oauth-device",
    );

    const oauthComplete = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      secondOauth.sessionId,
      secondOauth.sessionToken,
    );
    if (oauthComplete.status !== "complete") {
      throw new Error(`Expected oauth complete, got ${oauthComplete.status}`);
    }
    expect(oauthComplete.account).toMatchObject({
      authMethod: "oauth",
      connectionStatus: "connected",
      oauthScopes: ["read", "granted"],
    });
    expect(JSON.stringify(oauthComplete.account)).not.toContain(
      "test-device-access:",
    );
    await expect(
      connectors.readDefaultBuiltinAccount(member, "test-oauth-device"),
    ).resolves.toMatchObject({ id: oauthComplete.connectionId });
    const listed = await connectors.listBuiltinConnectors(member);
    expect(
      listed.connectors.map((entry) => {
        return entry.id;
      }),
    ).toContain(oauthComplete.connectionId);

    const repollProvider = mockTestOAuthDeviceConnectorProvider({
      tokenScope: "read granted",
    });
    const repolled = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      secondOauth.sessionId,
      secondOauth.sessionToken,
    );
    if (repolled.status !== "complete") {
      throw new Error(`Expected repoll complete, got ${repolled.status}`);
    }
    expect(repolled.connectionId).toBe(oauthComplete.connectionId);
    expect(repollProvider.tokenBodies).toStrictEqual([]);
  });

  it("connectors.bdd-012 (1/2) walks interval-gated, pending, slow-down, and denied device poll states", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await connectors.updateFeatureSwitches(member, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const intervalProvider = mockTestOAuthDeviceConnectorProvider({
      interval: 5,
    });
    const intervalSession = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
    );
    const intervalPoll1 = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      intervalSession.sessionId,
      intervalSession.sessionToken,
    );
    const intervalPoll2 = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      intervalSession.sessionId,
      intervalSession.sessionToken,
    );
    expect(intervalPoll1).toStrictEqual({ status: "pending", interval: 5 });
    expect(intervalPoll2).toStrictEqual({ status: "pending", interval: 5 });
    expect(intervalProvider.tokenBodies).toStrictEqual([]);

    mockTestOAuthDeviceConnectorProvider({ deviceCode: "pending" });
    const pendingSession = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
    );
    await expect(
      connectors.pollDeviceAuth(
        member,
        "test-oauth-device",
        pendingSession.sessionId,
        pendingSession.sessionToken,
      ),
    ).resolves.toStrictEqual({ status: "pending", interval: 0 });
    await expect(
      connectors.pollDeviceAuth(
        member,
        "test-oauth-device",
        pendingSession.sessionId,
        pendingSession.sessionToken,
      ),
    ).resolves.toStrictEqual({ status: "pending", interval: 0 });

    mockTestOAuthDeviceConnectorProvider({ deviceCode: "slow-down" });
    const slowSession = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
    );
    await expect(
      connectors.pollDeviceAuth(
        member,
        "test-oauth-device",
        slowSession.sessionId,
        slowSession.sessionToken,
      ),
    ).resolves.toStrictEqual({ status: "pending", interval: 5 });
    const afterSlowProvider = mockTestOAuthDeviceConnectorProvider({
      deviceCode: "slow-down",
    });
    await expect(
      connectors.pollDeviceAuth(
        member,
        "test-oauth-device",
        slowSession.sessionId,
        slowSession.sessionToken,
      ),
    ).resolves.toStrictEqual({ status: "pending", interval: 5 });
    expect(afterSlowProvider.tokenBodies).toStrictEqual([]);

    mockTestOAuthDeviceConnectorProvider({ deviceCode: "denied" });
    const deniedSession = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
    );
    const denied1 = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      deniedSession.sessionId,
      deniedSession.sessionToken,
    );
    expect(denied1).toMatchObject({
      status: "denied",
      errorCode: "access_denied",
    });
    const afterDeniedProvider = mockTestOAuthDeviceConnectorProvider({
      deviceCode: "denied",
    });
    const denied2 = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      deniedSession.sessionId,
      deniedSession.sessionToken,
    );
    expect(denied2).toStrictEqual(denied1);
    expect(afterDeniedProvider.tokenBodies).toStrictEqual([]);
  });

  it("connectors.bdd-012 (2/2) walks expired, error, unrecognized-code, and locally expired device poll states", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await connectors.updateFeatureSwitches(member, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    for (const arm of [
      {
        deviceCode: "expired",
        status: "expired",
        error: "expired_token",
      },
      {
        deviceCode: "error",
        status: "error",
        error: "invalid_request",
      },
      {
        deviceCode: "unrecognized-code",
        status: "error",
        error: "invalid_grant",
      },
    ]) {
      mockTestOAuthDeviceConnectorProvider({ deviceCode: arm.deviceCode });
      const session = await connectors.startDeviceAuth(
        member,
        "test-oauth-device",
        "oauth",
      );
      const first = await connectors.pollDeviceAuth(
        member,
        "test-oauth-device",
        session.sessionId,
        session.sessionToken,
      );
      expect(first).toMatchObject({
        status: arm.status,
        errorCode: arm.error,
      });
      const repollProvider = mockTestOAuthDeviceConnectorProvider({
        deviceCode: arm.deviceCode,
      });
      const second = await connectors.pollDeviceAuth(
        member,
        "test-oauth-device",
        session.sessionId,
        session.sessionToken,
      );
      expect(second).toStrictEqual(first);
      expect(repollProvider.tokenBodies).toStrictEqual([]);
    }

    const startedAt = now();
    mockNow(startedAt);
    mockTestOAuthDeviceConnectorProvider({ expiresIn: 1 });
    const expiringSession = await connectors.startDeviceAuth(
      member,
      "test-oauth-device",
      "oauth",
    );
    mockNow(startedAt + 2000);
    const localExpired1 = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      expiringSession.sessionId,
      expiringSession.sessionToken,
    );
    const localExpired2 = await connectors.pollDeviceAuth(
      member,
      "test-oauth-device",
      expiringSession.sessionId,
      expiringSession.sessionToken,
    );
    expect(localExpired1).toMatchObject({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "OAuth device authorization session expired",
    });
    expect(localExpired2).toStrictEqual(localExpired1);
  });

  it("connectors.bdd-017 settles device connector facts once across concurrent connections and reconnects", async () => {
    const consumer = marketingRewardConsumer();
    mockBase44OAuthProvider();
    mockSlockOAuthProvider();
    const member = bdd.user({ orgRole: "org:member" });

    const [base44Start, slockStart] = await Promise.all([
      connectors.startDeviceAuth(member, "base44", "oauth"),
      connectors.startDeviceAuth(member, "slock", "oauth"),
    ]);
    const [base44InitialResp, slockInitialResp] = await Promise.all([
      connectors.requestDeviceAuthPoll(
        member,
        "base44",
        base44Start.sessionId,
        base44Start.sessionToken,
        [200],
      ),
      connectors.requestDeviceAuthPoll(
        member,
        "slock",
        slockStart.sessionId,
        slockStart.sessionToken,
        [200],
      ),
    ]);
    const base44Initial = base44InitialResp.body;
    const slockInitial = slockInitialResp.body;
    if (
      !("status" in base44Initial) ||
      base44Initial.status !== "complete" ||
      !("status" in slockInitial) ||
      slockInitial.status !== "complete"
    ) {
      throw new Error("Expected initial Base44 and Slock sessions to complete");
    }

    const [base44ReStart, slockReStart] = await Promise.all([
      connectors.startDeviceAuth(member, "base44", "oauth", undefined, {
        intent: "reconnect",
        connectionId: base44Initial.connectionId,
      }),
      connectors.startDeviceAuth(member, "slock", "oauth", undefined, {
        intent: "reconnect",
        connectionId: slockInitial.connectionId,
      }),
    ]);
    const [base44ReResp, slockReResp] = await Promise.all([
      connectors.requestDeviceAuthPoll(
        member,
        "base44",
        base44ReStart.sessionId,
        base44ReStart.sessionToken,
        [200],
      ),
      connectors.requestDeviceAuthPoll(
        member,
        "slock",
        slockReStart.sessionId,
        slockReStart.sessionToken,
        [200],
      ),
    ]);
    const base44Re = base44ReResp.body;
    const slockRe = slockReResp.body;
    if (
      !("status" in base44Re) ||
      base44Re.status !== "complete" ||
      !("status" in slockRe) ||
      slockRe.status !== "complete"
    ) {
      throw new Error("Expected Base44 and Slock reconnects to complete");
    }
    expect(base44Re.connectionId).toBe(base44Initial.connectionId);
    expect(slockRe.connectionId).toBe(slockInitial.connectionId);

    await flushWaitUntilForTest();
    const oauthFacts = consumer.received.filter((event) => {
      return event.type === "connector.oauth-authorized";
    });
    expect(oauthFacts).toHaveLength(4);

    await Promise.all(
      oauthFacts.map(async (fact) => {
        if (fact.type !== "connector.oauth-authorized") {
          return;
        }
        const sourceKey =
          fact.connector.kind === "custom"
            ? "custom"
            : `builtin:${fact.connector.connectorSlug}`;
        await settleMarketingRequest(context, {
          version: 1,
          environment: fact.environment,
          policy: "get-started-v1",
          sourceEventId: fact.id,
          questKey: "connector",
          sourceKey,
          rewardKey: `connector:${fact.userId}:${sourceKey}`,
          orgId: fact.orgId,
          actorUserId: fact.userId,
          beneficiaryUserId: fact.userId,
          rewardTarget: "user",
          rewardAmount: 100,
          completedAt: fact.occurredAt,
        });
      }),
    );

    const credits = await readUsagePackCredits(member);
    expect(credits.bonusCredits).toBe(200);
    const bonusGrants = credits.creditGrants.filter((grant) => {
      return grant.grantType === "bonus";
    });
    expect(bonusGrants).toHaveLength(2);
    for (const grant of bonusGrants) {
      expect(grant).toMatchObject({
        amount: 100,
        remaining: 100,
      });
    }
  });

  it("connectors.bdd-018 (1/2) completes a Base44 device session with provider metadata visible through connector reads", async () => {
    const base44Provider = mockBase44OAuthProvider();
    const member = bdd.user({ orgRole: "org:member" });

    const base44Start = await connectors.startDeviceAuth(
      member,
      "base44",
      "oauth",
    );
    expect(base44Start).toMatchObject({
      status: "pending",
      userCode: "BASE-44",
      verificationUri: "https://app.base44.com/device",
      verificationUriComplete:
        "https://app.base44.com/device?user_code=BASE-44",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(base44Start)).not.toContain("base44-device-code");
    expect(base44Provider.deviceCodeBodies[0]).toMatchObject({
      client_id: "base44_cli",
      scope: "apps:read apps:write offline",
    });

    const base44Poll = await connectors.pollDeviceAuth(
      member,
      "base44",
      base44Start.sessionId,
      base44Start.sessionToken,
    );
    if (base44Poll.status !== "complete") {
      throw new Error(`Expected Base44 complete, got ${base44Poll.status}`);
    }
    expect(base44Provider.tokenBodies[0]?.get("device_code")).toBe(
      "base44-device-code",
    );
    expect(base44Provider.userinfoAuthorizations[0]).toBe(
      "Bearer base44-access-token",
    );

    const base44Account = await connectors.readDefaultBuiltinAccount(
      member,
      "base44",
    );
    expect(base44Account).toMatchObject({
      connectionStatus: "connected",
      externalId: "base44-user-id",
      externalUsername: "Base44 User",
      externalEmail: "base44@example.com",
      oauthScopes: ["apps:read", "apps:write", "offline"],
    });
    expect(JSON.stringify(base44Account)).not.toContain("base44-access-token");
    expect(JSON.stringify(base44Account)).not.toContain("base44-refresh-token");
    await connectors.deleteDefaultBuiltinConnectorAccount(member, "base44");
  });

  it("connectors.bdd-018 (2/2) completes Slock device sessions and surfaces post-token metadata lookup failures", async () => {
    mockSlockOAuthProvider();
    const member = bdd.user({ orgRole: "org:member" });

    const beforeSlockMs = now();
    const slockStart = await connectors.startDeviceAuth(
      member,
      "slock",
      "oauth",
    );
    expect(slockStart).toMatchObject({
      status: "pending",
      userCode: "SLOCK-1",
    });
    const slockPoll = await connectors.pollDeviceAuth(
      member,
      "slock",
      slockStart.sessionId,
      slockStart.sessionToken,
    );
    if (slockPoll.status !== "complete") {
      throw new Error(`Expected Slock complete, got ${slockPoll.status}`);
    }
    const slockAccount = await connectors.readDefaultBuiltinAccount(
      member,
      "slock",
    );
    if (!slockAccount.tokenExpiresAt) {
      throw new Error("Expected Slock account with tokenExpiresAt");
    }
    expect(slockAccount).toMatchObject({
      connectionStatus: "connected",
      externalId: "slock-user-id",
      externalUsername: "Slock User",
      externalEmail: "slock@example.com",
      oauthScopes: [],
    });
    const secondsAhead =
      (Date.parse(slockAccount.tokenExpiresAt) - beforeSlockMs) / 1000;
    expect(secondsAhead).toBeGreaterThanOrEqual(850);
    expect(secondsAhead).toBeLessThanOrEqual(905);
    expect(JSON.stringify(slockAccount)).not.toContain("slock-refresh-token");
    await connectors.deleteDefaultBuiltinConnectorAccount(member, "slock");

    mockSlockOAuthProvider({ deviceCode: "userinfo-error" });
    const failingSlock = await connectors.startDeviceAuth(
      member,
      "slock",
      "oauth",
    );
    const fail1 = await connectors.pollDeviceAuth(
      member,
      "slock",
      failingSlock.sessionId,
      failingSlock.sessionToken,
    );
    const fail2 = await connectors.pollDeviceAuth(
      member,
      "slock",
      failingSlock.sessionId,
      failingSlock.sessionToken,
    );
    expect(fail1).toMatchObject({
      status: "error",
      errorCode: "post_token_lookup_failed",
      errorMessage:
        "Unable to load Slock account metadata after authorization.",
    });
    expect(fail2).toStrictEqual(fail1);
  });

  it("connectors.bdd-025 stores an OAuth app config and lets members authorize", async () => {
    mockEnv("APP_URL", "https://app.okou.test");
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = memberOf(admin);
    const provider = mockCustomConnectorOAuth2Provider(context);
    const prefixBase = `https://oauth-app.${randomUUID()}.example.test`;

    const missingSecret = await connectors.requestCreateCustomConnector(
      admin,
      oauthHttpBody({
        displayName: "Custom OAuth API",
        prefix: `${prefixBase}/v1/`,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        scopes: ["read", "write"],
      }),
      [400],
    );
    expect(errorMessage(missingSecret.body).toLowerCase()).toContain(
      "client secret is required",
    );

    const createdBody = oauthHttpBody({
      displayName: "Custom OAuth API",
      prefix: `${prefixBase}/v1/`,
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      scopes: ["read", "write"],
      clientSecret: "custom-oauth-app-secret",
    });
    const created = await connectors.createCustomConnector(admin, createdBody);
    expect(created).toMatchObject({
      authMode: "oauth",
      storageVersion: 1,
      oauthConfig: expect.objectContaining({
        clientId: "branded-oauth-client-id",
        scopes: ["read", "write"],
      }),
    });
    expect(JSON.stringify(created)).not.toContain("custom-oauth-app-secret");

    const authUrlString = await connectors.startCustomConnectorOAuth2(
      member,
      created.id,
      { intent: "add" },
    );
    const authUrl = new URL(authUrlString);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
      provider.authorizationUrl,
    );
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("client_id")).toBe(
      "branded-oauth-client-id",
    );
    expect(authUrl.searchParams.get("scope")).toBe("read write");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.test/connectors/custom/callback",
    );

    await connectors.updateCustomConnector(admin, created.id, {
      ...oauthHttpBody({
        displayName: "Custom OAuth API",
        prefix: `${prefixBase}/v2/`,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        scopes: ["read", "write"],
      }),
    });

    const firstCallback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "custom-code-1",
        state: oauthStateFromUrl(authUrlString),
      });
    expect(firstCallback.body).toStrictEqual({
      status: "success",
      username: null,
    });
    expect(firstCallback.headers.get("cache-control")).toBe("no-store");
    expect(provider.tokenBodies[0]?.get("grant_type")).toBe(
      "authorization_code",
    );
    expect(provider.tokenBodies[0]?.get("client_secret")).toBe(
      "custom-oauth-app-secret",
    );

    const accountsAfterFirst = await connectors.listCustomConnectorAccounts(
      member,
      created.id,
    );
    const firstAccount = accountsAfterFirst[0];
    if (!firstAccount) {
      throw new Error("Expected connected custom OAuth account");
    }
    expect(firstAccount.connectionStatus).toBe("connected");
    expect(JSON.stringify(accountsAfterFirst)).not.toContain(
      "custom-oauth-app-secret",
    );
    expect(JSON.stringify(accountsAfterFirst)).not.toContain(
      "custom-oauth-initial-access-token",
    );

    const reconnectUrl = await connectors.startCustomConnectorOAuth2(
      member,
      created.id,
      { intent: "reconnect", connectionId: firstAccount.id },
    );
    const reconnectCallback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "custom-code-2",
        state: oauthStateFromUrl(reconnectUrl),
      });
    expect(reconnectCallback.body).toStrictEqual({
      status: "success",
      username: null,
    });
    const accountsAfterReconnect = await connectors.listCustomConnectorAccounts(
      member,
      created.id,
    );
    expect(accountsAfterReconnect[0]?.id).toBe(firstAccount.id);

    const deletedReconnectUrl = await connectors.startCustomConnectorOAuth2(
      member,
      created.id,
      { intent: "reconnect", connectionId: firstAccount.id },
    );
    await connectors.deleteCustomConnectorAccount(
      member,
      created.id,
      firstAccount.id,
    );
    const deletedCallback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "custom-code-3",
        state: oauthStateFromUrl(deletedReconnectUrl),
      });
    expect(deletedCallback.body).toStrictEqual({
      status: "error",
      message: "Connector account not found",
    });
    await expect(
      connectors.listCustomConnectorAccounts(member, created.id),
    ).resolves.toStrictEqual([]);

    const freshUrl = await connectors.startCustomConnectorOAuth2(
      member,
      created.id,
      { intent: "add" },
    );
    const freshCallback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "custom-code-4",
        state: oauthStateFromUrl(freshUrl),
      });
    expect(freshCallback.body).toStrictEqual({
      status: "success",
      username: null,
    });
    await expect(
      connectors.listCustomConnectorAccounts(member, created.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
  });

  it("connectors.bdd-030 keeps OAuth state target-scoped and aligns Custom lifecycle with Builtin", async () => {
    mockGitHubConnectorOAuth();
    const admin = bdd.user({ orgRole: "org:admin" });
    const owner = memberOf(admin);
    const peer = memberOf(admin);
    const provider = mockCustomConnectorOAuth2Provider(context);
    const custom = await connectors.createCustomConnector(
      admin,
      oauthHttpBody({
        displayName: "Scoped Custom OAuth",
        prefix: `https://scoped.${randomUUID()}.example.test/v1/`,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        scopes: ["read"],
        clientSecret: "scoped-secret",
      }),
    );

    const ownerAuthUrl = await connectors.startCustomConnectorOAuth2(
      owner,
      custom.id,
    );
    const ownerState = oauthStateFromUrl(ownerAuthUrl);

    const wrongTargetGithub = await connectors.completeOauthCallback("github", {
      code: "gh-cross",
      state: ownerState,
    });
    const wrongTargetUrl = redirectLocationUrl(wrongTargetGithub.headers);
    expect(wrongTargetUrl.pathname).toBe("/connector/error");
    expect(wrongTargetUrl.searchParams.get("message")).toBe(
      "Invalid state - please try again",
    );

    const missingCode =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state: ownerState,
      });
    expect(missingCode.body).toStrictEqual({
      status: "error",
      message: "Missing authorization code",
    });
    expect(provider.tokenBodies).toStrictEqual([]);

    const succeeded =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "owner-code",
        state: ownerState,
      });
    expect(succeeded.body).toStrictEqual({
      status: "success",
      username: null,
    });
    await expect(
      connectors.listCustomConnectorAccounts(owner, custom.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
    await expect(
      connectors.listCustomConnectorAccounts(peer, custom.id),
    ).resolves.toStrictEqual([]);

    const replayed =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "owner-replay",
        state: ownerState,
      });
    expect(replayed.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });

    const deniedStart = await connectors.startCustomConnectorOAuth2(
      owner,
      custom.id,
    );
    const deniedState = oauthStateFromUrl(deniedStart);
    const denied = await connectors.completeCustomConnectorOAuth2CallbackResult(
      {
        state: deniedState,
        error: "access_denied",
        error_description: "Provider denied access",
      },
    );
    expect(denied.body).toStrictEqual({
      status: "error",
      message: "Provider denied access",
    });
    const deniedReplay =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "after-deny",
        state: deniedState,
      });
    expect(deniedReplay.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });

    const peerGithubStart = await connectors.startOauth(
      peer,
      "github",
      "oauth",
    );
    const peerGithubState = oauthStateFromUrl(peerGithubStart.authorizationUrl);
    const wrongTargetCustom =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "gh-on-custom",
        state: peerGithubState,
      });
    expect(wrongTargetCustom.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });
    const peerGithubComplete = await connectors.completeOauthCallback(
      "github",
      {
        code: "peer-gh-code",
        state: peerGithubState,
      },
    );
    expect(redirectLocationUrl(peerGithubComplete.headers).pathname).toBe(
      "/connector/success",
    );
    await expect(
      connectors.readDefaultBuiltinAccount(peer, "github"),
    ).resolves.toMatchObject({ connectionStatus: "connected" });

    const startedAt = now();
    mockNow(startedAt);
    const expiringCustomStart = await connectors.startCustomConnectorOAuth2(
      peer,
      custom.id,
    );
    const expiringState = oauthStateFromUrl(expiringCustomStart);
    mockNow(startedAt + 16 * 60_000);
    const expired1 =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "late-code",
        state: expiringState,
      });
    const expired2 =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state: expiringState,
      });
    expect(expired1.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });
    expect(expired2.body).toStrictEqual({
      status: "error",
      message: "Invalid OAuth state - please try again",
    });
    await expect(
      connectors.listCustomConnectorAccounts(peer, custom.id),
    ).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-031 reuses confidential OAuth for MCP and connects the agent", async () => {
    bdd.acceptStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = memberOf(admin);
    const provider = mockCustomConnectorOAuth2Provider(context);
    const endpointBase = `https://mcp-oauth-${randomUUID()}.example.test`;

    const missingSecret = await connectors.requestCreateCustomConnector(
      admin,
      oauthMcpBody({
        displayName: "OAuth MCP",
        endpoint: `${endpointBase}/v1/server`,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        scopes: ["read"],
      }),
      [400],
    );
    expect(errorMessage(missingSecret.body).toLowerCase()).toContain(
      "client secret is required",
    );

    const created = await connectors.createCustomConnector(
      admin,
      oauthMcpBody({
        displayName: "OAuth MCP",
        endpoint: `${endpointBase}/v1/server`,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        scopes: ["read"],
        clientSecret: "mcp-confidential-secret",
      }),
    );
    expect(created).toMatchObject({
      kind: "mcp",
      authMode: "oauth",
      storageVersion: 1,
    });
    await expect(
      connectors.listCustomConnectorAccounts(member, created.id),
    ).resolves.toStrictEqual([]);
    expect(JSON.stringify(created)).not.toContain("mcp-confidential-secret");

    const authUrl = await connectors.startCustomConnectorOAuth2(
      member,
      created.id,
    );
    const moved = await connectors.updateCustomConnector(
      admin,
      created.id,
      oauthMcpBody({
        displayName: "OAuth MCP",
        endpoint: `${endpointBase}/v2/server`,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        scopes: ["read"],
      }),
    );
    expect(moved.id).toBe(created.id);
    expect(moved.storageVersion).toBe(1);

    const callback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "mcp-code",
        state: oauthStateFromUrl(authUrl),
      });
    expect(callback.body).toStrictEqual({
      status: "success",
      username: null,
    });
    expect(provider.tokenBodies[0]?.get("client_secret")).toBe(
      "mcp-confidential-secret",
    );

    const readBack = await connectors.readCustomConnector(member, created.id);
    expect(JSON.stringify(readBack)).not.toContain("mcp-confidential-secret");
    await expect(
      connectors.listCustomConnectorAccounts(member, created.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
  });

  it("connectors.bdd-032 connects an Automatic MCP OAuth account through Okou CIMD", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const admin = bdd.user({ orgRole: "org:admin" });
    const provider = automaticProvider({
      registration: "cimd",
      authentication: "oauth",
      challengeScope: "read write",
      identity: {
        subject: "cimd-sub-1",
        userInfoUsername: "cimd-user",
        userInfoEmail: "cimd@example.test",
      },
    });
    const connector = await createAutomaticConnector(admin, provider.endpoint);

    const authUrlString = await connectors.startCustomConnectorOAuth2(
      admin,
      connector.id,
    );
    const authUrl = new URL(authUrlString);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
      `${provider.issuer}/authorize`,
    );
    expect(authUrl.searchParams.get("client_id")).toBe(
      "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
    );
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/custom/callback",
    );
    expect(authUrl.searchParams.get("resource")).toBe(provider.endpoint);
    expect(authUrl.searchParams.get("scope")).toBe("read write");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const callback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "cimd-code",
        state: oauthStateFromUrl(authUrlString),
        iss: provider.issuer,
      });
    expect(callback.body).toStrictEqual({
      status: "success",
      username: null,
    });
    expect(provider.registrationBodies).toStrictEqual([]);
    expect(provider.tokenBodies[0]?.get("resource")).toBe(provider.endpoint);
    expect(provider.tokenBodies[0]?.get("client_id")).toBe(
      "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
    );

    const readBack = await connectors.readCustomConnector(admin, connector.id);
    expect(readBack).toMatchObject({
      authMode: "automatic",
    });
    const accounts = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    expect(accounts).toStrictEqual([
      expect.objectContaining({
        connectionStatus: "connected",
        externalId: "cimd-sub-1",
        externalUsername: "cimd-user",
        externalEmail: "cimd@example.test",
        oauthScopes: ["read", "write"],
      }),
    ]);
  });

  it("connectors.bdd-034 resolves Automatic MCP auth and reconnects the exact account across none and OAuth", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const admin = bdd.user({ orgRole: "org:admin" });
    const endpoint = `https://switch-mcp-${randomUUID()}.example.test/server`;
    const issuer = `https://switch-issuer-${randomUUID()}.example.test`;
    mockAutomaticMcpOAuthProvider(context, {
      endpoint,
      issuer,
      registration: "none",
      authentication: "none",
    });
    const connector = await createAutomaticConnector(admin, endpoint);

    const firstStart = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
    );
    expect(firstStart.body).toMatchObject({ result: "connected" });
    await expect(
      connectors.readCustomConnector(admin, connector.id),
    ).resolves.toMatchObject({
      authMode: "automatic",
    });
    const [initialAccount] = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    if (!initialAccount) {
      throw new Error("Expected initial no-auth account");
    }
    expect(initialAccount).toMatchObject({
      authMethod: "none",
      connectionStatus: "connected",
    });

    mockAutomaticMcpOAuthProvider(context, {
      endpoint,
      issuer,
      registration: "cimd",
      authentication: "oauth",
    });
    const oauthReconnectStart =
      await connectors.requestStartCustomConnectorOAuth2(
        admin,
        connector.id,
        [200],
        { intent: "reconnect", connectionId: initialAccount.id },
      );
    if (
      !("result" in oauthReconnectStart.body) ||
      oauthReconnectStart.body.result !== "authorization"
    ) {
      throw new Error("Expected authorization handoff for OAuth reconnect");
    }
    expect(
      (await connectors.listCustomConnectorAccounts(admin, connector.id))[0]
        ?.authMethod,
    ).toBe("none");

    await connectors.completeCustomConnectorOAuth2CallbackResult({
      code: "switch-oauth-code",
      state: oauthStateFromUrl(oauthReconnectStart.body.authorizationUrl),
      iss: issuer,
    });
    const [afterOauthAccount] = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    expect(afterOauthAccount).toMatchObject({
      id: initialAccount.id,
      authMethod: "oauth",
      connectionStatus: "connected",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
    });

    mockAutomaticMcpOAuthProvider(context, {
      endpoint,
      issuer,
      registration: "none",
      authentication: "none",
    });
    const noAuthReconnect = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
      { intent: "reconnect", connectionId: initialAccount.id },
    );
    expect(noAuthReconnect.body).toMatchObject({ result: "connected" });
    const [afterNoAuthReconnect] = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    expect(afterNoAuthReconnect).toMatchObject({
      id: initialAccount.id,
      authMethod: "none",
    });

    const siblingStart = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
      { intent: "add", displayName: "No-auth sibling" },
    );
    expect(siblingStart.body).toMatchObject({ result: "connected" });
    const finalAccounts = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    expect(finalAccounts).toHaveLength(2);
    expect(
      finalAccounts.some((account) => {
        return account.id !== initialAccount.id;
      }),
    ).toBeTruthy();
  });

  it("connectors.bdd-036 reuses one DCR client across Automatic MCP OAuth accounts", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const admin = bdd.user({ orgRole: "org:admin" });
    const provider = automaticProvider({
      registration: "dcr",
      authentication: "oauth",
      challengeScope: "read write",
    });
    const connector = await createAutomaticConnector(admin, provider.endpoint);

    const firstUrl = await connectors.startCustomConnectorOAuth2(
      admin,
      connector.id,
    );
    expect(new URL(firstUrl).searchParams.get("client_id")).toBe(
      "automatic-dcr-client",
    );
    await connectors.completeCustomConnectorOAuth2CallbackResult({
      code: "dcr-code-1",
      state: oauthStateFromUrl(firstUrl),
      iss: provider.issuer,
    });

    const secondUrl = await connectors.startCustomConnectorOAuth2(
      admin,
      connector.id,
      { intent: "add", displayName: "Second" },
    );
    await connectors.completeCustomConnectorOAuth2CallbackResult({
      code: "dcr-code-2",
      state: oauthStateFromUrl(secondUrl),
      iss: provider.issuer,
    });

    expect(provider.registrationBodies).toStrictEqual([
      expect.objectContaining({
        redirect_uris: ["https://app.okou.ai/connectors/custom/callback"],
        scope: "read write",
      }),
    ]);
    const expectedBasic = `Basic ${Buffer.from(
      "automatic-dcr-client:automatic-dcr-secret",
    ).toString("base64")}`;
    expect(provider.tokenAuthorizationHeaders).toStrictEqual([
      expectedBasic,
      expectedBasic,
    ]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toHaveLength(2);
  });

  it("connectors.bdd-060 authorizes Automatic OAuth through DCR and CIMD and requires reauthorization after definition changes", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const admin = bdd.user({ orgRole: "org:admin" });
    const dcrProvider = automaticProvider({
      registration: "dcr",
      authentication: "oauth",
      authorizationCodeErrors: [null, "invalid_grant"],
    });
    const cimdProvider = automaticProvider({
      registration: "cimd",
      authentication: "oauth",
    });

    const dcrConnector = await createAutomaticConnector(
      admin,
      dcrProvider.endpoint,
    );
    const dcrStart1 = await connectors.startCustomConnectorOAuth2(
      admin,
      dcrConnector.id,
    );
    await connectors.completeCustomConnectorOAuth2CallbackResult({
      code: "dcr-ok",
      state: oauthStateFromUrl(dcrStart1),
      iss: dcrProvider.issuer,
    });
    expect(dcrProvider.registrationBodies).toHaveLength(1);
    const dcrRead = await connectors.readCustomConnector(
      admin,
      dcrConnector.id,
    );
    expect("oauthConfig" in dcrRead && dcrRead.oauthConfig).toBeFalsy();
    expect(JSON.stringify(dcrRead)).not.toContain("automatic-dcr-secret");
    const [dcrAccount] = await connectors.listCustomConnectorAccounts(
      admin,
      dcrConnector.id,
    );
    if (!dcrAccount) {
      throw new Error("Expected connected DCR account");
    }
    expect(dcrAccount).toMatchObject({
      authMethod: "oauth",
      connectionStatus: "connected",
    });

    const dcrReconnect = await connectors.startCustomConnectorOAuth2(
      admin,
      dcrConnector.id,
      { intent: "reconnect", connectionId: dcrAccount.id },
    );
    const failingCallback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "dcr-fail",
        state: oauthStateFromUrl(dcrReconnect),
        iss: dcrProvider.issuer,
      });
    expect(failingCallback.body).toStrictEqual({
      status: "error",
      message: "OAuth token exchange failed - please try again",
    });

    const cimdConnector = await createAutomaticConnector(
      admin,
      cimdProvider.endpoint,
    );
    const cimdStart = await connectors.startCustomConnectorOAuth2(
      admin,
      cimdConnector.id,
    );
    await connectors.completeCustomConnectorOAuth2CallbackResult({
      code: "cimd-ok",
      state: oauthStateFromUrl(cimdStart),
      iss: cimdProvider.issuer,
    });
    expect(cimdProvider.registrationBodies).toStrictEqual([]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, cimdConnector.id),
    ).resolves.toMatchObject([
      { authMethod: "oauth", connectionStatus: "connected" },
    ]);

    const staticProvider = mockCustomConnectorOAuth2Provider(context);
    const switchedToStatic = await connectors.updateCustomConnector(
      admin,
      dcrConnector.id,
      oauthMcpBody({
        displayName: "Automatic MCP",
        endpoint: dcrProvider.endpoint,
        authorizationUrl: staticProvider.authorizationUrl,
        tokenUrl: staticProvider.tokenUrl,
        scopes: ["read"],
        clientSecret: "switched-static-secret",
      }),
    );
    expect(switchedToStatic.storageVersion).toBe(2);
    await expect(
      connectedAccounts(admin, dcrConnector.id),
    ).resolves.toStrictEqual([]);

    const switchedBack = await connectors.updateCustomConnector(
      admin,
      dcrConnector.id,
      {
        kind: "mcp",
        displayName: "Automatic MCP",
        endpoint: dcrProvider.endpoint,
        transport: "streamable-http",
        authMode: "automatic",
        fields: [],
        headerInjections: [],
        queryInjections: [],
      },
    );
    expect(switchedBack).toMatchObject({
      authMode: "automatic",
      storageVersion: 3,
    });
  });

  it("connectors.bdd-061 requires member reauthorization after incompatible OAuth settings changes", async () => {
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = memberOf(admin);
    const provider = mockCustomConnectorOAuth2Provider(context);
    const prefixBase = `https://incompat.${randomUUID()}.example.test`;

    const created = await connectors.createCustomConnector(
      admin,
      oauthHttpBody({
        displayName: "Scoped API",
        prefix: `${prefixBase}/v1/`,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        scopes: ["read"],
        clientSecret: "incompat-oauth-secret",
      }),
    );
    const firstAuthUrl = await connectors.startCustomConnectorOAuth2(
      member,
      created.id,
    );
    await connectors.completeCustomConnectorOAuth2CallbackResult({
      code: "incompat-code-1",
      state: oauthStateFromUrl(firstAuthUrl),
    });
    const [memberAccount] = await connectors.listCustomConnectorAccounts(
      member,
      created.id,
    );
    if (!memberAccount) {
      throw new Error("Expected connected member account");
    }

    const updatedBody = oauthHttpBody({
      displayName: "Scoped API v2",
      prefix: `${prefixBase}/v2/`,
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      scopes: ["read", "write"],
    });
    const memberUpdate = await connectors.requestUpdateCustomConnector(
      member,
      created.id,
      updatedBody,
      [403],
    );
    expect(errorMessage(memberUpdate.body)).toContain("Only org admins");

    const adminUpdated = await connectors.updateCustomConnector(
      admin,
      created.id,
      updatedBody,
    );
    expect(adminUpdated).toMatchObject({
      displayName: "Scoped API v2",
      prefixTemplates: [`${prefixBase}/v2/`],
      storageVersion: 2,
      oauthConfig: expect.objectContaining({
        clientId: "branded-oauth-client-id",
        scopes: ["read", "write"],
      }),
    });
    expect(JSON.stringify(adminUpdated)).not.toContain("incompat-oauth-secret");

    const [invalidatedAccount] = await connectors.listCustomConnectorAccounts(
      member,
      created.id,
    );
    expect(invalidatedAccount).toMatchObject({
      connectionStatus: "reconnect-required",
      reconnectReason: "configuration_invalid",
      missingRequiredFields: [],
    });

    const reconnectUrlString = await connectors.startCustomConnectorOAuth2(
      member,
      created.id,
      { intent: "reconnect", connectionId: memberAccount.id },
    );
    const reconnectUrl = new URL(reconnectUrlString);
    expect(reconnectUrl.searchParams.get("client_id")).toBe(
      "branded-oauth-client-id",
    );
    expect(reconnectUrl.searchParams.get("scope")).toBe("read write");

    await connectors.completeCustomConnectorOAuth2CallbackResult({
      code: "incompat-code-2",
      state: oauthStateFromUrl(reconnectUrlString),
    });
    await expect(
      connectors.readCustomConnector(member, created.id),
    ).resolves.toMatchObject({
      storageVersion: 2,
    });
    await expect(
      connectors.listCustomConnectorAccounts(member, created.id),
    ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
  });

  it("connectors.bdd-092 rejects malformed and unclaimable callbacks through visible redirects", async () => {
    mockGitHubConnectorOAuth();
    const member = bdd.user({ orgRole: "org:member" });

    const unknown = await connectors.completeOauthCallback("does-not-exist", {
      state: "any-state",
    });
    const unknownUrl = redirectLocationUrl(unknown.headers);
    expect(unknownUrl.pathname).toBe("/connector/error");
    expect(unknownUrl.searchParams.get("connectorSlug")).toBe("does-not-exist");
    expect(unknownUrl.searchParams.get("message")).toBe(
      "Unknown connector slug",
    );

    for (const slug of ["cloudinary", "test-oauth-device"]) {
      const nonAuthCode = await connectors.completeOauthCallback(slug, {
        state: "any-state",
      });
      const nonAuthCodeUrl = redirectLocationUrl(nonAuthCode.headers);
      expect(nonAuthCodeUrl.pathname).toBe("/connector/error");
      expect(nonAuthCodeUrl.searchParams.get("connectorSlug")).toBe(slug);
      expect(nonAuthCodeUrl.searchParams.get("message")).toContain(
        "does not use an auth-code grant",
      );
    }

    const neverStored = await connectors.completeOauthCallback("github", {
      code: "orphan-code",
      state: "never-stored-state",
    });
    const neverStoredUrl = redirectLocationUrl(neverStored.headers);
    expect(neverStoredUrl.pathname).toBe("/connector/error");
    expect(neverStoredUrl.searchParams.get("connectorSlug")).toBe("github");
    expect(neverStoredUrl.searchParams.get("message")).toBe(
      "Invalid state - please try again",
    );
    expectClearedOAuthCookies(neverStored.headers);

    const missingState = await connectors.completeOauthCallback("github", {
      code: "orphan-code",
    });
    const missingStateUrl = redirectLocationUrl(missingState.headers);
    expect(missingStateUrl.pathname).toBe("/connector/error");
    expect(missingStateUrl.searchParams.get("connectorSlug")).toBe("github");
    expect(missingStateUrl.searchParams.get("message")).toBe(
      "Missing state parameter",
    );

    const ghStart = await connectors.startOauth(member, "github", "oauth");
    const ghState = oauthStateFromUrl(ghStart.authorizationUrl);

    const crossSlug = await connectors.completeOauthCallback("linear", {
      code: "cross-code",
      state: ghState,
    });
    const crossSlugUrl = redirectLocationUrl(crossSlug.headers);
    expect(crossSlugUrl.pathname).toBe("/connector/error");
    expect(crossSlugUrl.searchParams.get("connectorSlug")).toBe("linear");
    expect(crossSlugUrl.searchParams.get("message")).toBe(
      "Invalid state - please try again",
    );

    const validGithub = await connectors.completeOauthCallback("github", {
      code: "valid-gh-code",
      state: ghState,
    });
    const validGithubUrl = redirectLocationUrl(validGithub.headers);
    expect(validGithubUrl.pathname).toBe("/connector/success");
    expect(validGithubUrl.searchParams.get("connectorSlug")).toBe("github");
    expect(validGithubUrl.searchParams.get("username")).toBe("bdd-github-user");

    await expect(
      connectors.readDefaultBuiltinAccount(member, "github"),
    ).resolves.toMatchObject({
      authMethod: "oauth",
      connectionStatus: "connected",
    });
    await expect(
      connectors.listBuiltinConnectorAccounts(member, "linear"),
    ).resolves.toStrictEqual([]);
  });

  it("connectors.bdd-093 claims, preserves, and invalidates stored OAuth state across code-less, error, and expired callbacks", async () => {
    mockGitHubConnectorOAuth();
    const member = bdd.user({ orgRole: "org:member" });

    const firstStart = await connectors.startOauth(member, "github", "oauth");
    const firstState = oauthStateFromUrl(firstStart.authorizationUrl);

    const codeless1 = await connectors.completeOauthCallback("github", {
      state: firstState,
    });
    const codeless1Url = redirectLocationUrl(codeless1.headers);
    expect(codeless1Url.pathname).toBe("/connector/error");
    expect(codeless1Url.searchParams.get("message")).toBe(
      "Missing authorization code",
    );
    expectClearedOAuthCookies(codeless1.headers);

    const completed = await connectors.completeOauthCallback("github", {
      code: "gh-first-code",
      state: firstState,
    });
    const completedUrl = redirectLocationUrl(completed.headers);
    expect(completedUrl.pathname).toBe("/connector/success");
    expect(completedUrl.searchParams.get("username")).toBe("bdd-github-user");

    const firstAccount = await connectors.readDefaultBuiltinAccount(
      member,
      "github",
    );
    if (!firstAccount) {
      throw new Error("Expected connected GitHub account");
    }

    const secondStart = await connectors.startOauth(member, "github", "oauth");
    const codeless2 = await connectors.completeOauthCallback("github", {
      state: oauthStateFromUrl(secondStart.authorizationUrl),
    });
    expect(
      redirectLocationUrl(codeless2.headers).searchParams.get("message"),
    ).toBe("Missing authorization code");

    const thirdStart = await connectors.startOauth(member, "github", "oauth");
    const denied = await connectors.completeOauthCallback("github", {
      state: oauthStateFromUrl(thirdStart.authorizationUrl),
      error: "access_denied",
      error_description: "Provider denied access",
    });
    expect(
      redirectLocationUrl(denied.headers).searchParams.get("message"),
    ).toBe("Provider denied access");

    const replayCodeless = await connectors.completeOauthCallback("github", {
      state: firstState,
    });
    expect(
      redirectLocationUrl(replayCodeless.headers).searchParams.get("message"),
    ).toBe("Invalid state - please try again");

    const replayError = await connectors.completeOauthCallback("github", {
      state: firstState,
      error: "access_denied",
    });
    expect(
      redirectLocationUrl(replayError.headers).searchParams.get("message"),
    ).toBe("Invalid state - please try again");

    const startedAt = now();
    mockNow(startedAt);
    const expiringStart = await connectors.startOauth(
      member,
      "github",
      "oauth",
    );
    mockNow(startedAt + 15 * 60_000 + 1000);
    const expired = await connectors.completeOauthCallback("github", {
      code: "late-gh-code",
      state: oauthStateFromUrl(expiringStart.authorizationUrl),
    });
    expect(
      redirectLocationUrl(expired.headers).searchParams.get("message"),
    ).toBe("Invalid state - please try again");

    const finalAccount = await connectors.readDefaultBuiltinAccount(
      member,
      "github",
    );
    expect(finalAccount).toStrictEqual(firstAccount);
  });

  it("connectors.bdd-095 persists reported and normalized effective scopes through auth-code callbacks", async () => {
    const admin = bdd.user({ orgRole: "org:admin" });
    await connectors.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    mockTestOAuthAuthCodeProvider({ scope: "read provider-added" });
    const firstStart = await connectors.startOauth(
      admin,
      "test-oauth",
      "oauth",
    );
    const firstCallback = await connectors.completeOauthCallback("test-oauth", {
      code: "to-code-1",
      state: oauthStateFromUrl(firstStart.authorizationUrl),
    });
    expect(redirectLocationUrl(firstCallback.headers).pathname).toBe(
      "/connector/success",
    );

    const firstAccount = await connectors.readDefaultBuiltinAccount(
      admin,
      "test-oauth",
    );
    if (!firstAccount) {
      throw new Error("Expected connected test-oauth account");
    }
    expect(firstAccount).toMatchObject({
      connectionStatus: "connected",
      oauthScopes: ["read", "provider-added"],
    });
    const scopeDiff = await connectors.readDefaultBuiltinScopeDiff(
      admin,
      "test-oauth",
    );
    expect(scopeDiff).toStrictEqual({
      currentScopes: ["read"],
      storedScopes: ["read"],
      addedScopes: [],
      removedScopes: [],
    });

    mockTestOAuthAuthCodeProvider({ scope: null });
    const reconnectStart = await connectors.startOauth(
      admin,
      "test-oauth",
      "oauth",
      { intent: "reconnect", connectionId: firstAccount.id },
    );
    expect(
      new URL(reconnectStart.authorizationUrl).searchParams.get("scope"),
    ).toBe("read");
    const reconnectCallback = await connectors.completeOauthCallback(
      "test-oauth",
      {
        code: "to-code-2",
        state: oauthStateFromUrl(reconnectStart.authorizationUrl),
      },
    );
    expect(redirectLocationUrl(reconnectCallback.headers).pathname).toBe(
      "/connector/success",
    );

    const reconnectedAccount = await connectors.readDefaultBuiltinAccount(
      admin,
      "test-oauth",
    );
    expect(reconnectedAccount).toMatchObject({
      id: firstAccount.id,
      connectionStatus: "connected",
      oauthScopes: ["read"],
    });
  });

  it("connectors.bdd-096 replaces a manual-grant connection through the auth-code callback with method-scoped state cleanup", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    const member = bdd.user({ orgRole: "org:member" });
    await connectors.updateFeatureSwitches(member, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const manualAccount = await connectors.connectManualGrant(
      member,
      "test-oauth",
      "api-token",
      {
        apiToken: "manual-secret-token",
        inputVariable: "manual-input-var",
        tenantId: "tenant-1",
      },
    );

    const provider = mockTestOAuthAuthCodeProvider({
      accessToken: "oauth-secret-access",
    });
    const oauthStart = await connectors.startOauth(
      member,
      "test-oauth",
      "oauth",
      { intent: "reconnect", connectionId: manualAccount.id },
    );
    const oauthAuthUrl = new URL(oauthStart.authorizationUrl);
    expect(oauthAuthUrl.pathname).toContain("/authorize");
    expect(oauthAuthUrl.searchParams.get("client_id")).toBe(
      "test-oauth-client",
    );

    const oauthCallback = await connectors.completeOauthCallback("test-oauth", {
      code: "to-replace-code",
      state: oauthStateFromUrl(oauthStart.authorizationUrl),
    });
    const oauthCallbackUrl = redirectLocationUrl(oauthCallback.headers);
    expect(oauthCallbackUrl.pathname).toBe("/connector/success");
    expect(oauthCallbackUrl.searchParams.get("connectorSlug")).toBe(
      "test-oauth",
    );
    expect(oauthCallbackUrl.searchParams.get("username")).toBe(
      "bdd-test-oauth",
    );

    const firstTokenBody = provider.tokenBodies[0];
    expect(firstTokenBody?.get("grant_type")).toBe("authorization_code");
    expect(firstTokenBody?.get("client_id")).toBe("test-oauth-client");
    expect(firstTokenBody?.get("client_secret")).toBeTruthy();
    expect(firstTokenBody?.get("code")).toBe("to-replace-code");
    expect(firstTokenBody?.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/test-oauth/callback",
    );

    const afterOauth = await connectors.readDefaultBuiltinAccount(
      member,
      "test-oauth",
    );
    expect(afterOauth).toMatchObject({
      id: manualAccount.id,
      authMethod: "oauth",
      externalId: "bdd-test-oauth-user",
      externalUsername: "bdd-test-oauth",
      externalEmail: "bdd-test-oauth@example.test",
      oauthScopes: ["read"],
    });
    expect(JSON.stringify(afterOauth)).not.toContain("manual-secret-token");
    expect(JSON.stringify(afterOauth)).not.toContain("oauth-secret-access");
    await expect(
      connectors.readDefaultBuiltinScopeDiff(member, "test-oauth"),
    ).resolves.toStrictEqual({
      currentScopes: ["read"],
      storedScopes: ["read"],
      addedScopes: [],
      removedScopes: [],
    });

    mockTestOAuthAuthCodeProvider({ accessToken: "api-secret-access" });
    const apiStart = await connectors.startOauth(member, "test-oauth", "api", {
      intent: "reconnect",
      connectionId: manualAccount.id,
    });
    const apiCallback = await connectors.completeOauthCallback("test-oauth", {
      code: "to-api-code",
      state: oauthStateFromUrl(apiStart.authorizationUrl),
    });
    expect(redirectLocationUrl(apiCallback.headers).pathname).toBe(
      "/connector/success",
    );

    const afterApi = await connectors.readDefaultBuiltinAccount(
      member,
      "test-oauth",
    );
    expect(afterApi).toMatchObject({
      id: manualAccount.id,
      authMethod: "api",
    });
    expect(JSON.stringify(afterApi)).not.toContain("api-secret-access");
  });

  it("connectors.bdd-100 links the org GitHub installation when the GitHub connector completes OAuth", async () => {
    const admin = bdd.user({ orgRole: "org:admin" });
    const installationId = String(
      Number.parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16),
    );
    await connectors.installGithubAppViaApi(admin, installationId);
    mockGitHubConnectorOAuth({ userId: 42, login: "bdd-github-user" });

    const before = await connectors.readGithubIntegration(admin);
    expect(before).toMatchObject({
      installation: {
        status: "active",
        targetName: "bdd-github-org",
        isAdmin: true,
      },
      isConnected: false,
    });

    const started = await connectors.startOauth(admin, "github", "oauth");
    const callback = await connectors.completeOauthCallback("github", {
      code: "gh-link-code",
      state: oauthStateFromUrl(started.authorizationUrl),
    });
    expect(redirectLocationUrl(callback.headers).pathname).toBe(
      "/connector/success",
    );

    await flushWaitUntilForTest();
    const after = await connectors.readGithubIntegration(admin);
    expect(after).toMatchObject({
      isConnected: true,
      connectedGithubUserId: "42",
      connectedGithubUsername: "bdd-github-user",
    });
    expect(channelsPublishedTo(context.mocks, "github:changed")).toContain(
      `user:${admin.userId}`,
    );
  });
});

const RUN_SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const runApp = setupApp({
  context,
  routes: [
    ...chatEventsRoutes,
    ...cloudflareAccessRoutes,
    ...connectorAccountRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsGetRoutes,
    ...customConnectorsUpdateRoutes,
    ...customConnectorsDeleteRoutes,
    ...customConnectorsValuesSetRoutes,
    ...customConnectorOAuth2Routes,
    ...runnersRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentFirewallAuthRoutes,
    ...webhooksClerkRoutes,
  ],
});

const runChatEventsApi = runApp(chatEventsContract);
const runCloudflareAccessApi = runApp(cloudflareAccessContract);
const runConnectorAccountsApi = runApp(connectorAccountsContract);
const runCustomConnectorsApi = runApp(customConnectorsContract);
const runCustomConnectorByIdApi = runApp(customConnectorByIdContract);
const runCustomConnectorValuesApi = runApp(customConnectorValuesContract);
const runCustomConnectorOAuth2Api = runApp(customConnectorOAuth2Contract);
const runRunnerHeartbeatApi = runApp(runnersHeartbeatContract);
const runRunnerSyncApi = runApp(runnersConnectorRuntimeSyncContract);
const runByIdApi = runApp(runsByIdContract);
const runCancelApi = runApp(runsCancelContract);
const runAgentCompleteApi = runApp(webhookCompleteContract);
const runFirewallAuthApi = runApp(runWebhookContract);
const runClerkWebhookApi = runApp(webhookClerkContract);

function runBearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function runOfficialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function acceptRunAblyBatchPublish() {
  context.mocks.ably.batchPublish.mockImplementation((spec) => {
    const entries = Array.isArray(spec) ? spec : [spec];
    const results = entries.flatMap((entry) => {
      const channels: readonly unknown[] = Array.isArray(entry.channels)
        ? entry.channels
        : [entry.channels];
      return channels.map((channel) => {
        return {
          channel: String(channel),
          messageId: randomUUID(),
          serials: [null],
        };
      });
    });
    return Promise.resolve({
      successCount: results.length,
      failureCount: 0,
      results,
    });
  });
}

function findInlineCustomFirewall(
  firewalls: readonly ExecutionFirewallEntry[] | undefined,
  customConnectorId: string,
) {
  const entry = (firewalls ?? []).find((candidate) => {
    return (
      candidate.kind === "inline" &&
      candidate.customConnectorId === customConnectorId
    );
  });
  if (!entry || entry.kind !== "inline") {
    throw new Error(
      `Expected inline firewall entry for custom connector ${customConnectorId}`,
    );
  }
  return entry;
}

function firstInlineCustomFirewallApi(
  firewalls: readonly ExecutionFirewallEntry[] | undefined,
  customConnectorId: string,
) {
  const entry = findInlineCustomFirewall(firewalls, customConnectorId);
  const [api] = entry.firewall.apis;
  if (!api) {
    throw new Error(
      `Expected inline firewall API for custom connector ${customConnectorId}`,
    );
  }
  return {
    firewallName: entry.firewall.name,
    api,
    matched(sourceId: string) {
      return {
        name: entry.firewall.name,
        apiId: api.id ?? "api-0",
        base: api.base,
        customConnectorId,
        sourceId,
        routingVariables: {} as Record<string, string>,
      };
    },
  };
}

function findCustomSkillBundle(
  execution: RunnerExecutionInput,
  connectorSlug: string,
  connectorId: string,
) {
  const skillName = getCustomConnectorSkillName(connectorSlug, connectorId);
  return execution.startupInputs?.contentBundles?.skills.find((skill) => {
    return skill.name === skillName;
  });
}

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const missingId = randomUUID();
  const warmed = await settleIncludingAbort(async () => {
    await Promise.all([
      accept(
        runChatEventsApi.send({
          headers: {},
          body: {
            prompt: "warmup",
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
            hasTextContent: true,
          },
        }),
        [401],
      ),
      accept(runCloudflareAccessApi.list({ headers: {}, query: {} }), [401]),
      accept(
        runConnectorAccountsApi.connections({
          headers: {},
          query: { kind: "custom", customConnectorId: missingId },
        }),
        [401],
      ),
      accept(runCustomConnectorsApi.list({ headers: {} }), [401]),
      accept(
        runCustomConnectorByIdApi.delete({
          headers: {},
          params: { id: missingId },
        }),
        [401],
      ),
      accept(
        runCustomConnectorValuesApi.set({
          headers: {},
          params: { id: missingId },
          body: { values: [], account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        runCustomConnectorOAuth2Api.start({
          headers: {},
          params: { id: missingId },
          body: { account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        runRunnerHeartbeatApi.heartbeat({
          headers: {},
          body: {
            runnerId: missingId,
            group: "vm0/warmup",
            snapshotGeneration: 1,
            snapshotSequence: 1,
            totalVcpu: 1,
            totalMemoryMb: 1024,
            maxConcurrent: 1,
            allocatedVcpu: 0,
            allocatedMemoryMb: 0,
            runningCount: 0,
            admittableProfiles: ["vm0/default"],
            heldSandboxStates: [],
            heldHomeStates: [],
            activeReuseProducers: [],
            mode: "running",
          },
        }),
        [401],
      ),
      accept(
        runRunnerSyncApi.sync({
          headers: {},
          params: { runId: missingId },
          body: { targets: [{ kind: "builtin", connectorSlug: "slack" }] },
        }),
        [401],
      ),
      accept(
        runByIdApi.getById({ headers: {}, params: { id: missingId } }),
        [401],
      ),
      accept(
        runCancelApi.cancel({ headers: {}, params: { id: missingId } }),
        [401],
      ),
      accept(
        runAgentCompleteApi.complete({
          headers: {},
          body: { runId: missingId, exitCode: 1, error: "warmup" },
        }),
        [401],
      ),
      accept(
        runFirewallAuthApi.firewallAuth({
          headers: {},
          body: { authHeaders: {} },
        }),
        [401],
      ),
    ]);
  });
  if (!warmed.ok) {
    throw warmed.error;
  }
});

describe("connectors BDD Run flows", () => {
  const runsApi = createRunsApi(context);
  const chatCallbacks = createChatCallbacksApi(context);
  const webhooksApi = createWebhookCallbackApi(context);

  interface TrackedConnectorRun {
    readonly runId: string;
    readonly sandboxToken: string;
    readonly issuedAtMs: number;
    done: boolean;
  }

  interface StartedConnectorRun {
    readonly runId: string;
    readonly threadId: string;
    readonly execution: RunnerExecutionInput;
    readonly tracked: TrackedConnectorRun;
  }

  function signInRunActor(actor: ApiTestUser) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const emailId = `email_${actor.userId}`;
    mockClerkUsers(context, [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "BDD",
        lastName: "Connector",
      },
    ]);
    const memberships = actor.orgId
      ? [
          {
            id: `membership-${actor.userId}-${actor.orgId}`,
            createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
            role: actor.orgRole ?? "org:admin",
            organization: { id: actor.orgId },
            publicUserData: { userId: actor.userId },
          },
        ]
      : [];
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: memberships,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: memberships },
    );
    return RUN_SESSION_HEADERS;
  }

  function prepareConnectorRunEnv(actor = bdd.user({ orgRole: "org:admin" })) {
    if (!actor.orgId) {
      throw new Error("Expected org-scoped actor");
    }
    const orgId = actor.orgId;
    chatCallbacks.acceptChatObjectStorage();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    chatCallbacks.disableVapid();
    acceptRunAblyBatchPublish();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);

    const trackedRuns: TrackedConnectorRun[] = [];
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");

    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 1,
    };
    const runnerHostname = `runner-${runnerIdentity.runnerId}.okou.app`;

    webhooksApi.configureClerkWebhookSecret();
    webhooksApi.verifyNextClerkWebhook({
      type: "organization.created",
      data: { id: orgId, created_by: actor.userId, created_at: now() },
    });

    const runnerGroupPromise = runsApi.configureRunnerGroup({
      runnerIdentity,
      hostname: runnerHostname,
    });
    const orgCreatedPromise = accept(
      runClerkWebhookApi.post({ body: "{}", extraHeaders: {} }),
      [200],
    );
    let resolvedRunnerGroup: string | undefined;

    onTestFinished(async () => {
      const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
      mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
      if (resolvedRunnerGroup !== undefined) {
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", resolvedRunnerGroup);
      }
      context.mocks.ably.publish.mockResolvedValue(undefined);
      acceptRunAblyBatchPublish();
      const result = await settleIncludingAbort(async () => {
        await Promise.allSettled([runnerGroupPromise, orgCreatedPromise]);
        await flushWaitUntilForTest();
        const activeRuns = trackedRuns.filter((tracked) => {
          return !tracked.done;
        });
        if (activeRuns.length > 0) {
          const ownerHeaders = signInRunActor(actor);
          const groupedByTime = new Map<number, TrackedConnectorRun[]>();
          for (const tracked of activeRuns) {
            const group = groupedByTime.get(tracked.issuedAtMs) ?? [];
            group.push(tracked);
            groupedByTime.set(tracked.issuedAtMs, group);
          }
          for (const [issuedAtMs, group] of groupedByTime) {
            mockNow(issuedAtMs);
            await Promise.all(
              group.map(async (tracked) => {
                const current = await accept(
                  runByIdApi.getById({
                    headers: ownerHeaders,
                    params: { id: tracked.runId },
                  }),
                  [200],
                );
                if (
                  ["queued", "pending", "running"].includes(current.body.status)
                ) {
                  await accept(
                    runCancelApi.cancel({
                      headers: ownerHeaders,
                      params: { id: tracked.runId },
                    }),
                    [200],
                  );
                }
                if (
                  !["completed", "failed", "timeout"].includes(
                    current.body.status,
                  )
                ) {
                  await accept(
                    runAgentCompleteApi.complete({
                      headers: runBearerHeaders(tracked.sandboxToken),
                      body: {
                        runId: tracked.runId,
                        exitCode: 137,
                        error: "Run cancelled by test cleanup",
                      },
                    }),
                    [200],
                  );
                }
                tracked.done = true;
              }),
            );
          }
        }
        await flushWaitUntilForTest();
      });
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousRunnerGroup);
      clearMockNow();
      if (!result.ok) {
        throw result.error;
      }
    });

    async function awaitBootstrap(): Promise<string> {
      if (resolvedRunnerGroup !== undefined) {
        return resolvedRunnerGroup;
      }
      const [runnerGroup] = await Promise.all([
        runnerGroupPromise,
        orgCreatedPromise,
      ]);
      resolvedRunnerGroup = runnerGroup;
      return runnerGroup;
    }

    async function startRun(
      prompt = "Run connector verification",
    ): Promise<StartedConnectorRun> {
      const runnerGroup = await awaitBootstrap();
      const issuedAtMs = now();
      const sent = await accept(
        runChatEventsApi.send({
          headers: signInRunActor(actor),
          body: {
            prompt,
            model: null,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: prompt }],
            },
            hasTextContent: true,
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      const execution = await runsApi.nextReceivedExecution(runnerGroup);
      const tracked: TrackedConnectorRun = {
        runId: execution.runId,
        sandboxToken: execution.sandboxToken,
        issuedAtMs,
        done: false,
      };
      trackedRuns.push(tracked);
      return {
        runId: execution.runId,
        threadId: sent.body.threadId,
        execution,
        tracked,
      };
    }

    async function cancelAndAcknowledge(started: StartedConnectorRun) {
      await accept(
        runCancelApi.cancel({
          headers: signInRunActor(actor),
          params: { id: started.runId },
        }),
        [200],
      );
      await accept(
        runAgentCompleteApi.complete({
          headers: runBearerHeaders(started.execution.sandboxToken),
          body: {
            runId: started.runId,
            exitCode: 137,
            error: "Run cancelled",
          },
        }),
        [200],
      );
      started.tracked.done = true;
    }

    return {
      actor,
      orgId,
      awaitBootstrap,
      startRun,
      cancelAndAcknowledge,
    };
  }

  it(
    "connectors.bdd-029 requires fresh OAuth authorization after replacing manual credentials",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareConnectorRunEnv();
      const { actor } = envSetup;
      const prefix = `https://oauth-manual-${randomUUID().slice(0, 8)}.example.test/v1`;
      const provider = mockCustomConnectorOAuth2Provider(context);

      const created = await connectors.createCustomConnector(
        actor,
        oauthHttpBody({
          displayName: "OAuth To Manual",
          prefix,
          authorizationUrl: provider.authorizationUrl,
          tokenUrl: provider.tokenUrl,
          scopes: ["read"],
          clientSecret: "oauth-client-secret",
        }),
      );
      expect(created.storageVersion).toBe(1);

      const initialStart = await connectors.startCustomConnectorOAuth2(
        actor,
        created.id,
        { intent: "add" },
      );
      const initialCallback =
        await connectors.completeCustomConnectorOAuth2CallbackResult({
          code: "oauth-code-1",
          state: oauthStateFromUrl(initialStart),
        });
      expect(initialCallback.body.status).toBe("success");
      const [initialAccount] = await connectors.listCustomConnectorAccounts(
        actor,
        created.id,
      );
      if (!initialAccount) {
        throw new Error("Expected initial custom OAuth account");
      }
      expect(initialAccount).toMatchObject({
        connectionStatus: "connected",
        authMethod: "oauth",
      });
      const afterInitialList = await connectors.listCustomConnectors(actor);
      const afterInitial = afterInitialList.find((item) => {
        return item.id === created.id;
      });
      expect(afterInitial).toMatchObject({
        id: created.id,
        storageVersion: 1,
      });

      const updatedManual = await connectors.updateCustomConnector(
        actor,
        created.id,
        {
          displayName: "OAuth To Manual",
          prefixTemplates: [prefix],
          authMode: "manual",
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
          storageVersion: 2,
        },
      );
      expect(updatedManual).toMatchObject({
        storageVersion: 2,
        authMode: "manual",
      });
      await expect(
        connectors.listCustomConnectorAccounts(actor, created.id),
      ).resolves.toMatchObject([
        {
          id: initialAccount.id,
          connectionStatus: "reconnect-required",
        },
      ]);

      await connectors.setCustomConnectorValues(
        actor,
        created.id,
        [{ key: "api_key", kind: "secret", value: "manual-api-key" }],
        { intent: "reconnect", connectionId: initialAccount.id },
      );

      const started = await envSetup.startRun("Resolve manual custom key");
      const firewall = findInlineCustomFirewall(
        started.execution.firewalls,
        created.id,
      );
      const [api] = firewall.firewall.apis;
      if (!api) {
        throw new Error("Expected inline firewall API for custom connector");
      }
      const resolved = await accept(
        runFirewallAuthApi.firewallAuth({
          headers: runBearerHeaders(started.execution.firewallToken),
          body: {
            authHeaders: api.auth.headers ?? {},
            matchedFirewall: {
              name: firewall.firewall.name,
              apiId: api.id ?? "api-0",
              base: api.base,
              customConnectorId: created.id,
              sourceId: initialAccount.id,
              routingVariables: {},
            },
          },
        }),
        [200],
      );
      expect(resolved.body.headers.Authorization).toBe("Bearer manual-api-key");

      await envSetup.cancelAndAcknowledge(started);

      const restoredOauth = await connectors.updateCustomConnector(
        actor,
        created.id,
        {
          ...oauthHttpBody({
            displayName: "OAuth To Manual",
            prefix,
            authorizationUrl: provider.authorizationUrl,
            tokenUrl: provider.tokenUrl,
            scopes: ["read"],
            clientSecret: "oauth-client-secret",
          }),
          storageVersion: 3,
        },
      );
      expect(restoredOauth).toMatchObject({
        storageVersion: 3,
        authMode: "oauth",
      });
      const accountsAfterRestore = await connectors.listCustomConnectorAccounts(
        actor,
        created.id,
      );
      const restoredAccount = accountsAfterRestore.find((account) => {
        return account.id === initialAccount.id;
      });
      expect(restoredAccount).toMatchObject({
        id: initialAccount.id,
        connectionStatus: "reconnect-required",
        reconnectReason: "configuration_invalid",
      });

      const reconnectStart = await connectors.startCustomConnectorOAuth2(
        actor,
        created.id,
        { intent: "reconnect", connectionId: initialAccount.id },
      );
      const reconnectCallback =
        await connectors.completeCustomConnectorOAuth2CallbackResult({
          code: "oauth-code-2",
          state: oauthStateFromUrl(reconnectStart),
        });
      expect(reconnectCallback.body.status).toBe("success");

      const accountsAfterReconnect =
        await connectors.listCustomConnectorAccounts(actor, created.id);
      const reconnectedAccount = accountsAfterReconnect.find((account) => {
        return account.id === initialAccount.id;
      });
      expect(reconnectedAccount).toMatchObject({
        id: initialAccount.id,
        connectionStatus: "connected",
        authMethod: "oauth",
      });
    },
  );

  it(
    "connectors.bdd-065 lets an admin agent with an okou-scoped token create a manual definition that Connect can configure",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareConnectorRunEnv();
      const { actor } = envSetup;
      const started = await envSetup.startRun("Create manual connector");
      const okouToken = okouTokenFromExecution(started.execution);
      signInRunActor(actor);

      const agentCreated = await accept(
        runCustomConnectorsApi.create({
          headers: runBearerHeaders(okouToken),
          body: {
            displayName: "Agent Manual Connector",
            prefixTemplates: [
              `https://agent-manual-${randomUUID().slice(0, 8)}.example.test/v1`,
            ],
            authMode: "manual",
            fields: [
              {
                key: "secret",
                label: "Secret",
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
          },
        }),
        [201],
      );
      expect(agentCreated.body).toMatchObject({
        id: expect.any(String),
        authMode: "manual",
        storageVersion: 1,
      });
      await expect(
        connectors.listCustomConnectorAccounts(actor, agentCreated.body.id),
      ).resolves.toStrictEqual([]);

      const secretValue = `agent-secret-${randomUUID()}`;
      const connected = await connectors.setCustomConnectorValues(
        actor,
        agentCreated.body.id,
        [{ key: "secret", kind: "secret", value: secretValue }],
      );

      const [listed, accounts] = await Promise.all([
        connectors.listCustomConnectors(actor),
        connectors.listCustomConnectorAccounts(actor, agentCreated.body.id),
      ]);
      const configured = listed.find((item) => {
        return item.id === agentCreated.body.id;
      });
      expect(configured).toMatchObject({
        id: agentCreated.body.id,
        authMode: "manual",
      });
      expect(accounts).toMatchObject([
        {
          id: connected.connectionId,
          connectionStatus: "connected",
          configuredFieldKeys: ["secret"],
          missingRequiredFields: [],
        },
      ]);
      expect(JSON.stringify(listed)).not.toContain(secretValue);
      expect(JSON.stringify(accounts)).not.toContain(secretValue);
    },
  );

  it(
    "connectors.bdd-066 sets all manual custom connector values through the values endpoint",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kms = useSecretKmsProbe();
      const envSetup = prepareConnectorRunEnv();
      const { actor } = envSetup;

      const created = await connectors.createCustomConnector(actor, {
        displayName: "Values Endpoint Connector",
        prefixTemplates: ["https://{{variables.subdomain}}.example.test/v1"],
        authMode: "manual",
        fields: [
          { key: "api_key", label: "API key", kind: "secret", required: true },
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "variable",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
      });
      expect(created.storageVersion).toBe(1);

      const firstWrite = await connectors.setCustomConnectorValues(
        actor,
        created.id,
        [
          { key: "api_key", kind: "secret", value: "initial-secret" },
          { key: "subdomain", kind: "variable", value: "acme" },
        ],
      );
      expect(firstWrite.connectionId).toStrictEqual(expect.any(String));
      expect(kms.generateDataKeyCalls).toBe(1);
      expect(JSON.stringify(firstWrite)).not.toContain("initial-secret");

      const [account] = await connectors.listCustomConnectorAccounts(
        actor,
        created.id,
      );
      if (!account) {
        throw new Error("Expected connected custom account");
      }
      expect(account).toMatchObject({
        id: firstWrite.connectionId,
        connectionStatus: "connected",
        configuredFieldKeys: ["api_key", "subdomain"],
        missingRequiredFields: [],
      });

      const secondWrite = await connectors.setCustomConnectorValues(
        actor,
        created.id,
        [{ key: "api_key", kind: "secret", value: "updated-secret" }],
        { intent: "reconnect", connectionId: account.id },
      );
      expect(secondWrite.connectionId).toBe(account.id);
      expect(kms.generateDataKeyCalls).toBe(2);
      expect(JSON.stringify(secondWrite)).not.toContain("updated-secret");
      await expect(
        connectors.listCustomConnectorAccounts(actor, created.id),
      ).resolves.toMatchObject([
        {
          id: account.id,
          connectionStatus: "connected",
          configuredFieldKeys: ["api_key", "subdomain"],
          missingRequiredFields: [],
        },
      ]);

      const firstRun = await envSetup.startRun("Resolve updated manual secret");
      const firstFirewall = findInlineCustomFirewall(
        firstRun.execution.firewalls,
        created.id,
      );
      const [firstApi] = firstFirewall.firewall.apis;
      if (!firstApi) {
        throw new Error("Expected first inline firewall API");
      }
      const firstResolved = await accept(
        runFirewallAuthApi.firewallAuth({
          headers: runBearerHeaders(firstRun.execution.firewallToken),
          body: {
            authHeaders: firstApi.auth.headers ?? {},
            matchedFirewall: {
              name: firstFirewall.firewall.name,
              apiId: firstApi.id ?? "api-0",
              base: firstApi.base,
              customConnectorId: created.id,
              sourceId: account.id,
              routingVariables: { subdomain: "acme" },
            },
          },
        }),
        [200],
      );
      expect(firstResolved.body.headers.Authorization).toBe(
        "Bearer updated-secret",
      );
      expect(firstApi.base).toBe("https://acme.example.test/v1");

      await accept(
        runConnectorAccountsApi.delete({
          headers: signInRunActor(actor),
          params: { connectionId: account.id },
          body: { target: { kind: "custom", customConnectorId: created.id } },
        }),
        [200],
      );
      await expect(
        connectors.listCustomConnectorAccounts(actor, created.id),
      ).resolves.toStrictEqual([]);

      const reconnectedWrite = await connectors.setCustomConnectorValues(
        actor,
        created.id,
        [
          { key: "api_key", kind: "secret", value: "reconnected-secret" },
          { key: "subdomain", kind: "variable", value: "reconnected" },
        ],
      );
      expect(reconnectedWrite.connectionId).toStrictEqual(expect.any(String));
      expect(JSON.stringify(reconnectedWrite)).not.toContain(
        "reconnected-secret",
      );

      const [reconnectedAccount] = await connectors.listCustomConnectorAccounts(
        actor,
        created.id,
      );
      if (!reconnectedAccount) {
        throw new Error("Expected reconnected custom account");
      }
      expect(reconnectedAccount).toMatchObject({
        id: reconnectedWrite.connectionId,
        connectionStatus: "connected",
        configuredFieldKeys: ["api_key", "subdomain"],
        missingRequiredFields: [],
      });
      const secondRun = await envSetup.startRun(
        "Resolve reconnected manual secret",
      );
      const secondFirewall = findInlineCustomFirewall(
        secondRun.execution.firewalls,
        created.id,
      );
      const [secondApi] = secondFirewall.firewall.apis;
      if (!secondApi) {
        throw new Error("Expected second inline firewall API");
      }
      const secondResolved = await accept(
        runFirewallAuthApi.firewallAuth({
          headers: runBearerHeaders(secondRun.execution.firewallToken),
          body: {
            authHeaders: secondApi.auth.headers ?? {},
            matchedFirewall: {
              name: secondFirewall.firewall.name,
              apiId: secondApi.id ?? "api-0",
              base: secondApi.base,
              customConnectorId: created.id,
              sourceId: reconnectedAccount.id,
              routingVariables: { subdomain: "reconnected" },
            },
          },
        }),
        [200],
      );
      expect(secondResolved.body.headers.Authorization).toBe(
        "Bearer reconnected-secret",
      );
      expect(secondApi.base).toBe("https://reconnected.example.test/v1");
    },
  );

  it(
    "connectors.bdd-067 revokes usable custom credentials when the member disconnects",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareConnectorRunEnv();
      const { actor } = envSetup;

      const created = await connectors.createCustomConnector(actor, {
        displayName: "Disconnect Revoke Connector",
        prefixTemplates: [
          "https://{{variables.subdomain}}.revoke.example.test/v1",
        ],
        authMode: "manual",
        fields: [
          { key: "api_key", label: "API key", kind: "secret", required: true },
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "variable",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
      });
      await connectors.setCustomConnectorValues(actor, created.id, [
        { key: "api_key", kind: "secret", value: "shared-secret" },
        { key: "subdomain", kind: "variable", value: "tenant" },
      ]);
      const [account] = await connectors.listCustomConnectorAccounts(
        actor,
        created.id,
      );
      if (!account) {
        throw new Error("Expected custom connector account");
      }

      const started = await envSetup.startRun("Claim and revoke custom creds");
      const firewall = findInlineCustomFirewall(
        started.execution.firewalls,
        created.id,
      );
      const [api] = firewall.firewall.apis;
      if (!api) {
        throw new Error("Expected inline firewall API");
      }
      const firewallAuthBody = {
        authHeaders: api.auth.headers ?? {},
        matchedFirewall: {
          name: firewall.firewall.name,
          apiId: api.id ?? "api-0",
          base: api.base,
          customConnectorId: created.id,
          sourceId: account.id,
          routingVariables: { subdomain: "tenant" },
        },
      };

      const firstResolved = await accept(
        runFirewallAuthApi.firewallAuth({
          headers: runBearerHeaders(started.execution.firewallToken),
          body: firewallAuthBody,
        }),
        [200],
      );
      expect(firstResolved.body.headers.Authorization).toBe(
        "Bearer shared-secret",
      );

      await accept(
        runConnectorAccountsApi.delete({
          headers: signInRunActor(actor),
          params: { connectionId: account.id },
          body: { target: { kind: "custom", customConnectorId: created.id } },
        }),
        [200],
      );

      await accept(
        runFirewallAuthApi.firewallAuth({
          headers: runBearerHeaders(started.execution.firewallToken),
          body: firewallAuthBody,
        }),
        [424],
      );

      await expect(
        connectors.listCustomConnectorAccounts(actor, created.id),
      ).resolves.toStrictEqual([]);
    },
  );

  it(
    "connectors.bdd-069 isolates identical manual variable names by Custom connection",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareConnectorRunEnv();
      const { actor } = envSetup;

      const [firstConnector, secondConnector] = await Promise.all([
        connectors.createCustomConnector(actor, {
          displayName: "Region East Connector",
          prefixTemplates: [
            `https://east-${randomUUID().slice(0, 8)}.example.test/v1`,
          ],
          authMode: "manual",
          fields: [
            {
              key: "region",
              label: "Region",
              kind: "variable",
              required: true,
            },
          ],
          headerInjections: [],
          queryInjections: [
            { name: "region", valueTemplate: "{{variables.region}}" },
          ],
        }),
        connectors.createCustomConnector(actor, {
          displayName: "Region West Connector",
          prefixTemplates: [
            `https://west-${randomUUID().slice(0, 8)}.example.test/v1`,
          ],
          authMode: "manual",
          fields: [
            {
              key: "region",
              label: "Region",
              kind: "variable",
              required: true,
            },
          ],
          headerInjections: [],
          queryInjections: [
            { name: "region", valueTemplate: "{{variables.region}}" },
          ],
        }),
      ]);

      await Promise.all([
        connectors.setCustomConnectorValues(actor, firstConnector.id, [
          { key: "region", kind: "variable", value: "east" },
        ]),
        connectors.setCustomConnectorValues(actor, secondConnector.id, [
          { key: "region", kind: "variable", value: "west" },
        ]),
      ]);

      const [[firstAccount], [secondAccount], started] = await Promise.all([
        connectors.listCustomConnectorAccounts(actor, firstConnector.id),
        connectors.listCustomConnectorAccounts(actor, secondConnector.id),
        envSetup.startRun("Isolate identical region variable"),
      ]);
      if (!firstAccount || !secondAccount) {
        throw new Error("Expected distinct custom connector accounts");
      }
      expect(firstAccount.id).not.toBe(secondAccount.id);

      const firstFirewall = findInlineCustomFirewall(
        started.execution.firewalls,
        firstConnector.id,
      );
      const secondFirewall = findInlineCustomFirewall(
        started.execution.firewalls,
        secondConnector.id,
      );
      const [firstApi] = firstFirewall.firewall.apis;
      const [secondApi] = secondFirewall.firewall.apis;
      if (!firstApi || !secondApi) {
        throw new Error("Expected inline firewall APIs");
      }

      const [firstResolved, secondResolved] = await Promise.all([
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: runBearerHeaders(started.execution.firewallToken),
            body: {
              authHeaders: firstApi.auth.headers ?? {},
              authQuery: firstApi.auth.query,
              matchedFirewall: {
                name: firstFirewall.firewall.name,
                apiId: firstApi.id ?? "api-0",
                base: firstApi.base,
                customConnectorId: firstConnector.id,
                sourceId: firstAccount.id,
                routingVariables: {},
              },
            },
          }),
          [200],
        ),
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: runBearerHeaders(started.execution.firewallToken),
            body: {
              authHeaders: secondApi.auth.headers ?? {},
              authQuery: secondApi.auth.query,
              matchedFirewall: {
                name: secondFirewall.firewall.name,
                apiId: secondApi.id ?? "api-0",
                base: secondApi.base,
                customConnectorId: secondConnector.id,
                sourceId: secondAccount.id,
                routingVariables: {},
              },
            },
          }),
          [200],
        ),
      ]);

      expect(firstResolved.body.query).toStrictEqual({ region: "east" });
      expect(secondResolved.body.query).toStrictEqual({ region: "west" });
    },
  );

  it(
    "connectors.bdd-087 publishes exact skill versions and removes fresh mounts after clearing and deletion",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareConnectorRunEnv();
      const { actor } = envSetup;
      const prefix = `https://skill-versions-${randomUUID().slice(0, 8)}.example.test/v1`;
      const initialMarkdown = "# Initial Connector Skill\nUse v1 endpoint.";
      const updatedMarkdown = "# Updated Connector Skill\nUse v2 endpoint.";

      const created = await connectors.createCustomConnector(actor, {
        displayName: "Skill Version Connector",
        prefixTemplates: [prefix],
        authMode: "manual",
        permissionBundleRef: "builtin:slack@1",
        skillMarkdown: initialMarkdown,
        fields: [
          { key: "api_key", label: "API key", kind: "secret", required: true },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
      });
      expect(created).toMatchObject({
        permissionBundleRef: "builtin:slack@1",
        skillMarkdown: initialMarkdown,
      });

      await connectors.setCustomConnectorValues(actor, created.id, [
        { key: "api_key", kind: "secret", value: "skill-secret" },
      ]);

      const run1 = await envSetup.startRun("Observe initial skill mount");
      const skill1 = findCustomSkillBundle(
        run1.execution,
        created.slug,
        created.id,
      );
      expect(skill1?.bundle.sha256).toBeTruthy();
      await envSetup.cancelAndAcknowledge(run1);

      const updated = await connectors.updateCustomConnector(
        actor,
        created.id,
        {
          displayName: "Skill Version Connector",
          prefixTemplates: [prefix],
          authMode: "manual",
          permissionBundleRef: "builtin:slack@1",
          skillMarkdown: updatedMarkdown,
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
          storageVersion: created.storageVersion,
        },
      );
      expect(updated).toMatchObject({
        permissionBundleRef: "builtin:slack@1",
        skillMarkdown: updatedMarkdown,
      });

      const run2 = await envSetup.startRun("Observe updated skill mount");
      const skill2 = findCustomSkillBundle(
        run2.execution,
        created.slug,
        created.id,
      );
      expect(skill2?.bundle.sha256).toBeTruthy();
      expect(skill2?.bundle.sha256).not.toBe(skill1?.bundle.sha256);
      await envSetup.cancelAndAcknowledge(run2);

      const [clearedBundle, unknownBundleRes] = await Promise.all([
        connectors.updateCustomConnector(actor, created.id, {
          displayName: "Skill Version Connector",
          prefixTemplates: [prefix],
          authMode: "manual",
          permissionBundleRef: null,
          skillMarkdown: updatedMarkdown,
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
          storageVersion: updated.storageVersion,
        }),
        accept(
          runCustomConnectorsApi.create({
            headers: signInRunActor(actor),
            body: {
              displayName: "Unknown Bundle Connector",
              prefixTemplates: [
                `https://unknown-bundle-${randomUUID().slice(0, 8)}.example.test/v1`,
              ],
              authMode: "manual",
              permissionBundleRef: "builtin:not-a-connector@1",
              fields: [
                {
                  key: "api_key",
                  label: "API key",
                  kind: "secret",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.api_key}}",
                },
              ],
              queryInjections: [],
            },
          }),
          [400],
        ),
      ]);
      expect(clearedBundle).toMatchObject({
        permissionBundleRef: null,
        skillMarkdown: updatedMarkdown,
      });
      expect(errorMessage(unknownBundleRes.body)).toContain(
        "Unknown custom connector permission bundle",
      );

      const clearedSkill = await connectors.updateCustomConnector(
        actor,
        created.id,
        {
          displayName: "Skill Version Connector",
          prefixTemplates: [prefix],
          authMode: "manual",
          permissionBundleRef: null,
          skillMarkdown: null,
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
          storageVersion: clearedBundle.storageVersion,
        },
      );
      expect(clearedSkill.skillMarkdown).toBeNull();

      const run3 = await envSetup.startRun("Observe cleared skill mount");
      expect(
        findCustomSkillBundle(run3.execution, created.slug, created.id),
      ).toBeUndefined();
      await envSetup.cancelAndAcknowledge(run3);

      const restoredSkill = await connectors.updateCustomConnector(
        actor,
        created.id,
        {
          displayName: "Skill Version Connector",
          prefixTemplates: [prefix],
          authMode: "manual",
          permissionBundleRef: null,
          skillMarkdown: updatedMarkdown,
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
          storageVersion: clearedSkill.storageVersion,
        },
      );
      expect(restoredSkill.skillMarkdown).toBe(updatedMarkdown);

      const run4 = await envSetup.startRun("Observe restored skill mount");
      const skill4 = findCustomSkillBundle(
        run4.execution,
        created.slug,
        created.id,
      );
      expect(skill4?.bundle.sha256).toBe(skill2?.bundle.sha256);
      await envSetup.cancelAndAcknowledge(run4);

      await accept(
        runCustomConnectorByIdApi.delete({
          headers: signInRunActor(actor),
          params: { id: created.id },
        }),
        [204],
      );

      const [run5, listedAfterDelete] = await Promise.all([
        envSetup.startRun("Observe deleted connector skill mount"),
        connectors.listCustomConnectors(actor),
      ]);
      expect(
        findCustomSkillBundle(run5.execution, created.slug, created.id),
      ).toBeUndefined();
      expect(
        listedAfterDelete.some((item) => {
          return item.id === created.id;
        }),
      ).toBeFalsy();
    },
  );

  it(
    "connectors.bdd-098 stores token expiry variants and surfaces provider failures",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixedMs = Date.parse("2026-11-28T00:00:00.000Z");
      mockNow(fixedMs);
      const envSetup = prepareConnectorRunEnv();
      const { actor } = envSetup;

      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });

      mockTestOAuthAuthCodeProvider({
        accessToken: "bdd-test-oauth-access-token",
        expiresIn: 7200,
      });
      const firstStart = await connectors.startOauth(
        actor,
        "test-oauth",
        "oauth",
        { intent: "add" },
      );
      const firstCallback = await connectors.completeOauthCallback(
        "test-oauth",
        {
          code: "to-7200-code",
          state: oauthStateFromUrl(firstStart.authorizationUrl),
        },
      );
      expect(redirectLocationUrl(firstCallback.headers).pathname).toBe(
        "/connector/success",
      );
      const firstAccount = await connectors.readDefaultBuiltinAccount(
        actor,
        "test-oauth",
      );
      expect(firstAccount.tokenExpiresAt).toBe(
        new Date(fixedMs + 7200 * 1000).toISOString(),
      );

      mockTestOAuthAuthCodeProvider({
        accessToken: "bdd-test-oauth-access-token",
        omitExpiresIn: true,
      });
      const reconnectStart = await connectors.startOauth(
        actor,
        "test-oauth",
        "oauth",
        { intent: "reconnect", connectionId: firstAccount.id },
      );
      const reconnectCallback = await connectors.completeOauthCallback(
        "test-oauth",
        {
          code: "to-no-expiry-code",
          state: oauthStateFromUrl(reconnectStart.authorizationUrl),
        },
      );
      expect(redirectLocationUrl(reconnectCallback.headers).pathname).toBe(
        "/connector/success",
      );
      const afterReconnect = await connectors.readDefaultBuiltinAccount(
        actor,
        "test-oauth",
      );
      expect(afterReconnect.id).toBe(firstAccount.id);
      expect(afterReconnect.tokenExpiresAt).toBe(
        new Date(fixedMs + 15 * 60 * 1000).toISOString(),
      );

      const started = await envSetup.startRun("Resolve TEST_OAUTH_TOKEN");
      const resolveTestOAuth = () => {
        return accept(
          runFirewallAuthApi.firewallAuth({
            headers: runBearerHeaders(started.execution.firewallToken),
            body: {
              authHeaders: {
                Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
              },
              secretConnectorMap: { TEST_OAUTH_TOKEN: "test-oauth" },
              secretConnectorMetadataMap: {
                TEST_OAUTH_TOKEN: {
                  sourceType: "connector",
                  sourceId: firstAccount.id,
                },
              },
            },
          }),
          [200],
        );
      };
      const resolvedBeforeFailure = await resolveTestOAuth();
      expect(resolvedBeforeFailure.body.headers.Authorization).toBe(
        "Bearer bdd-test-oauth-access-token",
      );

      mockSlackConnectorOAuth();
      const slackStart = await connectors.startOauth(actor, "slack", "oauth", {
        intent: "add",
      });
      const slackCallback = await connectors.completeOauthCallback("slack", {
        code: "slack-ok-code",
        state: oauthStateFromUrl(slackStart.authorizationUrl),
      });
      expect(redirectLocationUrl(slackCallback.headers).pathname).toBe(
        "/connector/success",
      );
      const slackAccount = await connectors.readDefaultBuiltinAccount(
        actor,
        "slack",
      );
      expect(slackAccount).toMatchObject({
        externalId: "U012AB3CD",
        externalUsername: "BDD Slack User",
        tokenExpiresAt: null,
      });
      expect(JSON.stringify(slackAccount)).not.toContain("xoxp-bdd-user-token");

      mockTestOAuthAuthCodeProvider({ tokenError: true });
      const tokenFailStart = await connectors.startOauth(
        actor,
        "test-oauth",
        "oauth",
        { intent: "reconnect", connectionId: firstAccount.id },
      );
      const tokenFailCallback = await connectors.completeOauthCallback(
        "test-oauth",
        {
          code: "to-token-fail",
          state: oauthStateFromUrl(tokenFailStart.authorizationUrl),
        },
      );
      const tokenFailUrl = redirectLocationUrl(tokenFailCallback.headers);
      expect(tokenFailUrl.pathname).toBe("/connector/error");
      expect(tokenFailUrl.searchParams.get("message")).toBe(
        "OAuth authorization failed. Please try again.",
      );
      expectClearedOAuthCookies(tokenFailCallback.headers);

      mockTestOAuthAuthCodeProvider({ userinfoError: true });
      const userinfoFailStart = await connectors.startOauth(
        actor,
        "test-oauth",
        "oauth",
        { intent: "reconnect", connectionId: firstAccount.id },
      );
      const userinfoFailCallback = await connectors.completeOauthCallback(
        "test-oauth",
        {
          code: "to-userinfo-fail",
          state: oauthStateFromUrl(userinfoFailStart.authorizationUrl),
        },
      );
      const userinfoFailUrl = redirectLocationUrl(userinfoFailCallback.headers);
      expect(userinfoFailUrl.pathname).toBe("/connector/error");
      expect(userinfoFailUrl.searchParams.get("message")).toBe(
        "OAuth authorization failed. Please try again.",
      );

      const [accountAfterFailures, resolvedAfterFailures] = await Promise.all([
        connectors.readDefaultBuiltinAccount(actor, "test-oauth"),
        resolveTestOAuth(),
      ]);
      expect(accountAfterFailures.id).toBe(firstAccount.id);
      expect(resolvedAfterFailures.body.headers.Authorization).toBe(
        "Bearer bdd-test-oauth-access-token",
      );

      mockTestOAuthAuthCodeProvider({
        accessToken: "replacement-test-oauth-token",
        userId: "replacement-oauth-user",
        username: "replacement-user",
        email: "replacement-user@example.test",
      });
      const freshStart = await connectors.startOauth(
        actor,
        "test-oauth",
        "oauth",
        { intent: "add" },
      );
      const freshCallback = await connectors.completeOauthCallback(
        "test-oauth",
        {
          code: "to-fresh-user-code",
          state: oauthStateFromUrl(freshStart.authorizationUrl),
        },
      );
      expect(redirectLocationUrl(freshCallback.headers).pathname).toBe(
        "/connector/success",
      );
      const allAccounts = await connectors.listBuiltinConnectorAccounts(
        actor,
        "test-oauth",
      );
      const addedAccount = allAccounts.find((account) => {
        return account.externalId === "replacement-oauth-user";
      });
      expect(addedAccount).toMatchObject({
        externalId: "replacement-oauth-user",
        externalUsername: "replacement-user",
        externalEmail: "replacement-user@example.test",
      });
      expect(addedAccount?.id).not.toBe(firstAccount.id);
    },
  );

  it(
    "custom-connector-network-execution-001 chat account startup preserves HTTP/MCP network bindings and unbound Direct intent",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareConnectorRunEnv();
      const { actor } = envSetup;

      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
      });

      const accessConfigId = randomUUID();
      const createdAccess = await accept(
        runCloudflareAccessApi.create({
          headers: signInRunActor(actor),
          query: { view: "scoped" },
          body: {
            id: accessConfigId,
            scope: "organization",
            name: "Org Custom Connector Access",
            credentials: {
              clientId: "cf-client-id-v1",
              clientSecret: "cf-client-secret-v1",
            },
          },
        }),
        [201],
      );
      expect(createdAccess.body).toMatchObject({
        id: accessConfigId,
        scope: "organization",
        generation: 1,
        revision: 1,
      });

      const boundHttpBase = `https://bound-http-${randomUUID().slice(0, 8)}.example.test/v1`;
      const unboundHttpBase = `https://unbound-http-${randomUUID().slice(0, 8)}.example.test/v1`;
      const boundMcpEndpoint = `https://bound-mcp-${randomUUID().slice(0, 8)}.example.test/mcp`;
      const unboundMcpEndpoint = `https://unbound-mcp-${randomUUID().slice(0, 8)}.example.test/mcp`;

      const [boundHttp, unboundHttp, boundMcp, unboundMcp] = await Promise.all([
        connectors.createCustomConnector(actor, {
          displayName: "Bound HTTP",
          prefixTemplates: [boundHttpBase],
          networkBinding: {
            type: "cloudflare_access",
            configId: accessConfigId,
          },
          authMode: "manual",
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        }),
        connectors.createCustomConnector(actor, {
          displayName: "Unbound HTTP",
          prefixTemplates: [unboundHttpBase],
          authMode: "manual",
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        }),
        connectors.createCustomConnector(actor, {
          kind: "mcp",
          displayName: "Bound MCP",
          endpoint: boundMcpEndpoint,
          transport: "streamable-http",
          networkBinding: {
            type: "cloudflare_access",
            configId: accessConfigId,
          },
          authMode: "manual",
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        }),
        connectors.createCustomConnector(actor, {
          kind: "mcp",
          displayName: "Unbound MCP",
          endpoint: unboundMcpEndpoint,
          transport: "streamable-http",
          authMode: "manual",
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        }),
      ]);

      await Promise.all([
        connectors.setCustomConnectorValues(actor, boundHttp.id, [
          { key: "api_key", kind: "secret", value: "bound-http-secret" },
        ]),
        connectors.setCustomConnectorValues(actor, unboundHttp.id, [
          { key: "api_key", kind: "secret", value: "unbound-http-secret" },
        ]),
        connectors.setCustomConnectorValues(actor, boundMcp.id, [
          { key: "api_key", kind: "secret", value: "bound-mcp-secret" },
        ]),
        connectors.setCustomConnectorValues(actor, unboundMcp.id, [
          { key: "api_key", kind: "secret", value: "unbound-mcp-secret" },
        ]),
      ]);

      const [
        [boundHttpAcc],
        [unboundHttpAcc],
        [boundMcpAcc],
        [unboundMcpAcc],
        run1,
      ] = await Promise.all([
        connectors.listCustomConnectorAccounts(actor, boundHttp.id),
        connectors.listCustomConnectorAccounts(actor, unboundHttp.id),
        connectors.listCustomConnectorAccounts(actor, boundMcp.id),
        connectors.listCustomConnectorAccounts(actor, unboundMcp.id),
        envSetup.startRun("Inspect HTTP/MCP network bindings"),
      ]);
      if (!boundHttpAcc || !unboundHttpAcc || !boundMcpAcc || !unboundMcpAcc) {
        throw new Error("Expected accounts for all four custom connectors");
      }

      const customTargets = (
        run1.execution.connectorRuntimeTargets ?? []
      ).filter((target) => {
        return target.kind === "custom";
      });
      expect(
        customTargets.map((target) => {
          return {
            customConnectorId: target.customConnectorId,
            sourceId: target.sourceId,
          };
        }),
      ).toStrictEqual(
        expect.arrayContaining([
          { customConnectorId: boundHttp.id, sourceId: boundHttpAcc.id },
          { customConnectorId: unboundHttp.id, sourceId: unboundHttpAcc.id },
          { customConnectorId: boundMcp.id, sourceId: boundMcpAcc.id },
          { customConnectorId: unboundMcp.id, sourceId: unboundMcpAcc.id },
        ]),
      );

      const boundHttpTarget = firstInlineCustomFirewallApi(
        run1.execution.firewalls,
        boundHttp.id,
      );
      const unboundHttpTarget = firstInlineCustomFirewallApi(
        run1.execution.firewalls,
        unboundHttp.id,
      );
      const boundMcpTarget = firstInlineCustomFirewallApi(
        run1.execution.firewalls,
        boundMcp.id,
      );
      const unboundMcpTarget = firstInlineCustomFirewallApi(
        run1.execution.firewalls,
        unboundMcp.id,
      );

      const expectedAccessIntent = {
        kind: "cloudflare_access" as const,
        configId: accessConfigId,
        generation: 1,
      };
      expect(boundHttpTarget.api.networkIntent).toStrictEqual(
        expectedAccessIntent,
      );
      expect(boundMcpTarget.api.networkIntent).toStrictEqual(
        expectedAccessIntent,
      );
      expect(unboundHttpTarget.api.networkIntent).toStrictEqual({
        kind: "direct",
      });
      expect(unboundMcpTarget.api.networkIntent).toStrictEqual({
        kind: "direct",
      });

      const run1FirewallHeaders = runBearerHeaders(
        run1.execution.firewallToken,
      );
      const [authBoundHttp, authUnboundHttp, authBoundMcp, authUnboundMcp] =
        await Promise.all([
          accept(
            runFirewallAuthApi.firewallAuth({
              headers: run1FirewallHeaders,
              body: {
                authHeaders: boundHttpTarget.api.auth.headers ?? {},
                matchedFirewall: boundHttpTarget.matched(boundHttpAcc.id),
                networkIntent: expectedAccessIntent,
              },
            }),
            [200],
          ),
          accept(
            runFirewallAuthApi.firewallAuth({
              headers: run1FirewallHeaders,
              body: {
                authHeaders: unboundHttpTarget.api.auth.headers ?? {},
                matchedFirewall: unboundHttpTarget.matched(unboundHttpAcc.id),
                networkIntent: { kind: "direct" },
              },
            }),
            [200],
          ),
          accept(
            runFirewallAuthApi.firewallAuth({
              headers: run1FirewallHeaders,
              body: {
                authHeaders: boundMcpTarget.api.auth.headers ?? {},
                matchedFirewall: boundMcpTarget.matched(boundMcpAcc.id),
                networkIntent: expectedAccessIntent,
              },
            }),
            [200],
          ),
          accept(
            runFirewallAuthApi.firewallAuth({
              headers: run1FirewallHeaders,
              body: {
                authHeaders: unboundMcpTarget.api.auth.headers ?? {},
                matchedFirewall: unboundMcpTarget.matched(unboundMcpAcc.id),
                networkIntent: { kind: "direct" },
              },
            }),
            [200],
          ),
        ]);
      expect(authBoundHttp.body.headers.Authorization).toBe(
        "Bearer bound-http-secret",
      );
      expect(authUnboundHttp.body.headers.Authorization).toBe(
        "Bearer unbound-http-secret",
      );
      expect(authBoundMcp.body.headers.Authorization).toBe(
        "Bearer bound-mcp-secret",
      );
      expect(authUnboundMcp.body.headers.Authorization).toBe(
        "Bearer unbound-mcp-secret",
      );

      const wrongConfigId = randomUUID();
      const [
        missingIntentRes,
        directIntentRes,
        mismatchIntentRes,
        sandboxAdmitRes,
        runnerAdmitHttpRes,
        runnerAdmitMcpRes,
      ] = await Promise.all([
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: run1FirewallHeaders,
            body: {
              authHeaders: boundHttpTarget.api.auth.headers ?? {},
              matchedFirewall: boundHttpTarget.matched(boundHttpAcc.id),
            },
          }),
          [424],
        ),
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: run1FirewallHeaders,
            body: {
              authHeaders: boundHttpTarget.api.auth.headers ?? {},
              matchedFirewall: boundHttpTarget.matched(boundHttpAcc.id),
              networkIntent: { kind: "direct" },
            },
          }),
          [424],
        ),
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: run1FirewallHeaders,
            body: {
              authHeaders: boundMcpTarget.api.auth.headers ?? {},
              matchedFirewall: boundMcpTarget.matched(boundMcpAcc.id),
              networkIntent: {
                kind: "cloudflare_access",
                configId: wrongConfigId,
                generation: 1,
              },
            },
          }),
          [424],
        ),
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: runBearerHeaders(run1.execution.sandboxToken),
            body: {
              authHeaders: {},
              networkAdmission: true,
              matchedFirewall: boundHttpTarget.matched(boundHttpAcc.id),
              networkRequest: {
                method: "GET",
                url: `${boundHttpBase}/items`,
                intent: expectedAccessIntent,
              },
            },
          }),
          [401],
        ),
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: run1FirewallHeaders,
            body: {
              authHeaders: {},
              networkAdmission: true,
              matchedFirewall: boundHttpTarget.matched(boundHttpAcc.id),
              networkRequest: {
                method: "GET",
                url: `${boundHttpBase}/items`,
                intent: expectedAccessIntent,
              },
            },
          }),
          [200],
        ),
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: run1FirewallHeaders,
            body: {
              authHeaders: {},
              networkAdmission: true,
              matchedFirewall: boundMcpTarget.matched(boundMcpAcc.id),
              networkRequest: {
                method: "POST",
                url: boundMcpEndpoint,
                intent: expectedAccessIntent,
              },
            },
          }),
          [200],
        ),
      ]);
      expect(missingIntentRes.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
      expect(directIntentRes.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
      expect(mismatchIntentRes.body.error.code).toBe(
        "CONNECTOR_NOT_CONFIGURED",
      );
      expect(sandboxAdmitRes.status).toBe(401);
      expect(runnerAdmitHttpRes.body.networkAdmission).toStrictEqual({
        kind: "cloudflare_access",
        configId: accessConfigId,
        generation: 1,
        headers: {
          "CF-Access-Client-Id": "cf-client-id-v1",
          "CF-Access-Client-Secret": "cf-client-secret-v1",
        },
      });
      expect(runnerAdmitMcpRes.body.networkAdmission).toStrictEqual({
        kind: "cloudflare_access",
        configId: accessConfigId,
        generation: 1,
        headers: {
          "CF-Access-Client-Id": "cf-client-id-v1",
          "CF-Access-Client-Secret": "cf-client-secret-v1",
        },
      });

      const rotated = await accept(
        runCloudflareAccessApi.update({
          headers: signInRunActor(actor),
          query: { view: "scoped" },
          params: { configId: accessConfigId },
          body: {
            expectedRevision: 1,
            credentials: {
              clientId: "cf-client-id-v2",
              clientSecret: "cf-client-secret-v2",
            },
          },
        }),
        [200],
      );
      expect(rotated.body.generation).toBe(2);

      const rotatedIntent = {
        kind: "cloudflare_access" as const,
        configId: accessConfigId,
        generation: 2,
      };
      const [synced, admittedAfterRotation] = await Promise.all([
        accept(
          runRunnerSyncApi.sync({
            headers: runOfficialRunnerHeaders(),
            params: { runId: run1.runId },
            body: {
              targets: [
                {
                  kind: "custom",
                  customConnectorId: boundHttp.id,
                  baseUrlVars: {},
                  sourceId: boundHttpAcc.id,
                },
                {
                  kind: "custom",
                  customConnectorId: boundMcp.id,
                  baseUrlVars: {},
                  sourceId: boundMcpAcc.id,
                },
              ],
            },
          }),
          [200],
        ),
        accept(
          runFirewallAuthApi.firewallAuth({
            headers: run1FirewallHeaders,
            body: {
              authHeaders: {},
              networkAdmission: true,
              matchedFirewall: boundHttpTarget.matched(boundHttpAcc.id),
              networkRequest: {
                method: "GET",
                url: `${boundHttpBase}/items`,
                intent: rotatedIntent,
              },
            },
          }),
          [200],
        ),
      ]);
      const syncedIntents = synced.body.results.map((entry) => {
        return entry.state === "available" && "firewall" in entry
          ? entry.firewall.firewall.apis[0]?.networkIntent
          : null;
      });
      expect(syncedIntents).toStrictEqual([rotatedIntent, rotatedIntent]);
      expect(admittedAfterRotation.body.networkAdmission).toStrictEqual({
        kind: "cloudflare_access",
        configId: accessConfigId,
        generation: 2,
        headers: {
          "CF-Access-Client-Id": "cf-client-id-v2",
          "CF-Access-Client-Secret": "cf-client-secret-v2",
        },
      });

      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CustomConnectorCloudflareAccess]: false,
      });

      const run2 = await envSetup.startRun(
        "Verify bound connectors omitted after disabling Cloudflare Access",
      );
      const run2CustomIds = (run2.execution.connectorRuntimeTargets ?? [])
        .filter((target) => {
          return target.kind === "custom";
        })
        .map((target) => {
          return target.customConnectorId;
        });
      expect(run2CustomIds).not.toContain(boundHttp.id);
      expect(run2CustomIds).not.toContain(boundMcp.id);
      expect(run2CustomIds).toContain(unboundHttp.id);
      expect(run2CustomIds).toContain(unboundMcp.id);

      const run2InlineIds = (run2.execution.firewalls ?? [])
        .filter((entry) => {
          return entry.kind === "inline";
        })
        .map((entry) => {
          return entry.customConnectorId;
        });
      expect(run2InlineIds).not.toContain(boundHttp.id);
      expect(run2InlineIds).not.toContain(boundMcp.id);

      const run2UnboundHttpTarget = firstInlineCustomFirewallApi(
        run2.execution.firewalls,
        unboundHttp.id,
      );
      const run2UnboundMcpTarget = firstInlineCustomFirewallApi(
        run2.execution.firewalls,
        unboundMcp.id,
      );
      expect(run2UnboundHttpTarget.api.networkIntent).toBeUndefined();
      expect(run2UnboundMcpTarget.api.networkIntent).toBeUndefined();
    },
  );
});
