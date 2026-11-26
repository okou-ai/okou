import { randomUUID } from "node:crypto";

import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type {
  CreateCustomConnectorBody,
  SaveCustomConnectorProposalBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAutomaticMcpOAuthProvider,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

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
});
