import {
  customConnectorCompletionFixture,
  catalogFixture,
  httpConnectorFixture,
  mcpConnectorFixture,
  type HttpFixtureOverrides,
  type McpFixtureOverrides,
} from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  customConnectorAccount,
  mockOAuthCompletions,
} from "./connector-page-test-helpers.ts";
import {
  builtinConnectorOpenIdStartContract,
  builtinConnectorOauthStartContract,
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorAccountTargetKey,
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";

import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

test("Retry a failed target account read from the directed connection page", async () => {
  mockPublicConnectorStatus(
    publicOAuthConnectorStatus({
      slug: "github",
      label: "Public GitHub",
      singleAuthCodeAuthMethodId: "oauth",
    }),
  );
  let unavailable = true;
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        kind: "builtin",
        connectorSlug: "github",
      });
      return unavailable
        ? respond(403, {
            error: { code: "FORBIDDEN", message: "Account list unavailable" },
          })
        : respond(200, {
            connections: [],
            defaultConnection: null,
            nextCursor: null,
          });
    },
  );
  await setupPage({
    context,
    path: `/connectors/github/connect?agentId=${AGENT_ID}`,
  });
  await expect(
    screen.findByText("Accounts are unavailable for this connector."),
  ).resolves.toBeVisible();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Connect";
    }),
  ).toBeUndefined();
  unavailable = false;
  click(
    await waitFor(() => {
      return getButtonByText("Try again");
    }),
  );
  await screen.findByText("Okou needs Public GitHub to proceed");
  expect(getButtonByText("Connect")).toBeEnabled();
});

function mockAccounts(read: () => readonly ConnectorAccountConnection[]) {
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = read().find((candidate) => {
        return candidate.id === params.connectionId;
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const accounts = read().filter((account) => {
        return (
          connectorAccountTargetKey(account.target) ===
          connectorAccountTargetKey(query)
        );
      });
      return respond(200, {
        connections: accounts,
        nextCursor: null,
        defaultConnection:
          accounts.find((account) => {
            return account.isDefault;
          }) ?? null,
      });
    },
  );
}

function savedBuiltinResponse(connector: BuiltinConnectorResponse) {
  context.mocks.data.connectors([connector]);
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: connector.slug,
  });
  return connector;
}

function connectorIcon(connectorSlug: string) {
  return {
    url: `https://icons.example.test/${connectorSlug}.svg`,
    invertInDarkMode: false,
  };
}

function mockPublicConnectorStatus(
  connector: PublicConnectorCatalogStatusItem,
): void {
  mockPublicConnectorStatuses([connector]);
}

function mockPublicConnectorStatuses(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    const connector = connectors.find((candidate) => {
      return candidate.slug === params.connectorSlug;
    });
    return connector
      ? respond(200, { connector })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
  });
  // Registered after the slug route, which would otherwise also match it.
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
}

function publicManualTokenConnectorStatus(args: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
  readonly placeholder: string;
}): PublicConnectorCatalogStatusItem {
  return catalogFixture({
    slug: args.slug,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.slug),
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "api-token",
        label: "Public API Token",
        description: null,
        grantKind: "manual",
        supportsRefresh: false,
        manualFields: [
          {
            id: "apiToken",
            label: "Public API token",
            required: true,
            placeholder: args.placeholder,
            inputType: "password",
          },
        ],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  });
}

function publicOAuthConnectorStatus(args: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
  readonly singleAuthCodeAuthMethodId: string | null;
}): PublicConnectorCatalogStatusItem {
  return catalogFixture({
    slug: args.slug,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.slug),
    category: "engineering-team-execution",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "Public OAuth",
        description: "Public OAuth description",
        grantKind: "auth-code",
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId: args.singleAuthCodeAuthMethodId,
    connectNotice: null,
  });
}

function publicNoAuthConnectorStatus(args: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
}): PublicConnectorCatalogStatusItem {
  return catalogFixture({
    slug: args.slug,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.slug),
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "api",
        label: "Public catalog",
        description: null,
        grantKind: "none",
        supportsRefresh: false,
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  });
}

function connectedConnectorResponse(args: {
  readonly slug: BuiltinConnectorResponse["slug"];
  readonly authMethod: string;
  readonly updatedAt: string;
}): BuiltinConnectorResponse {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: args.slug,
    authMethod: args.authMethod,
    externalId: "mock-connected-account",
    externalUsername: "mock-connected-account",
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: args.updatedAt,
  };
}

function customConnector(
  overrides: HttpFixtureOverrides = {},
): CustomConnectorHttpResponse {
  return httpConnectorFixture({
    kind: "http",
    id: "33333333-3333-4333-8333-333333333333",
    storageVersion: 1,
    slug: "_acme-api",
    displayName: "Acme API",
    prefixTemplates: ["https://api.acme.test/v1/"],
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
    authMode: "manual",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function mcpCustomConnector(
  overrides: McpFixtureOverrides = {},
): CustomConnectorMcpResponse {
  return mcpConnectorFixture({
    kind: "mcp",
    id: "44444444-4444-4444-8444-444444444444",
    storageVersion: 1,
    slug: "_deepwiki",
    displayName: "DeepWiki",
    endpoint: "https://mcp.deepwiki.com/mcp",
    transport: "streamable-http",
    prefixTemplates: [],
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
        name: "X-Okou-Test-Token",
        valueTemplate: "{{secrets.secret}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
    permissionBundleRef: null,
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    ...overrides,
  });
}

function steamOpenIdConnectorStatus(): PublicConnectorCatalogStatusItem {
  return catalogFixture({
    slug: "steam",
    label: "Public Steam",
    description: "Public Steam description",
    icon: connectorIcon("steam"),
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "openid",
        label: "Public Steam sign-in",
        description: "Public Steam sign-in description",
        grantKind: "openid-auth",
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  });
}

function mockConnectorOauthStart(args?: {
  readonly popupClosed?: boolean;
  readonly onStart?: (
    agentId: string | undefined,
    authorizeAgent: true | undefined,
  ) => void;
}): {
  readonly authWindow: Window;
} {
  mockOAuthCompletions(context);
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = args?.popupClosed ?? true;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });

  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, params, respond }) => {
      args?.onStart?.(body.agentId, body.authorizeAgent);
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.connectorSlug}/authorize`,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  context.mocks.browser.open(authWindow);
  return { authWindow };
}

function mockConnectorOpenIdStart(args: {
  readonly oauthAttemptId: string;
  readonly onStart?: () => void;
  readonly popupClosed?: boolean;
}): {
  readonly authWindow: Window;
} {
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = args?.popupClosed ?? true;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });

  context.mocks.api(
    builtinConnectorOpenIdStartContract.start,
    ({ params, respond }) => {
      args?.onStart?.();
      return respond(200, {
        authorizationUrl: `https://openid.test/${params.connectorSlug}/authorize`,
        oauthAttemptId: args.oauthAttemptId,
      });
    },
  );
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ never }) => {
    return never();
  });
  context.mocks.browser.open(authWindow);
  return { authWindow };
}

function getButtonByText(text: string, container?: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

test("Connect and authorize a manual MCP connector", async () => {
  const connectionId = crypto.randomUUID();
  let connected = false;
  let grants: AgentCustomConnectorGrant[] = [];
  let submittedValues: readonly {
    readonly key: string;
    readonly kind: "secret" | "variable";
    readonly value: string;
  }[] = [];
  const connector = mcpCustomConnector();
  mockAccounts(() => {
    return connected
      ? [
          customConnectorAccount(connector.id, {
            id: connectionId,
            configuredFieldKeys: ["secret"],
          }),
        ]
      : [];
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [connector],
    });
  });
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ body, params, respond }) => {
      expect(params.id).toBe(connector.id);
      submittedValues = body.values;
      connected = true;
      return respond(
        200,
        customConnectorCompletionFixture(
          mcpConnectorFixture({
            ...connector,
            account: {
              id: connectionId,
              missingRequiredFields: [],
              configuredFieldKeys: ["secret"],
            },
          }),
        ),
      );
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      expect(params.id).toBe(AGENT_ID);
      grants = body.grants;
      return respond(200, { grants });
    },
  );

  await setupPage({
    context,
    path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
  });

  const heading = await screen.findByText("Okou needs DeepWiki to proceed");
  expect(heading).toBeInTheDocument();
  click(getButtonByText("Connect"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect DeepWiki",
  });
  await fill(within(dialog).getByLabelText("Secret"), "acme-secret");
  click(getButtonByText("Save"));

  await waitFor(() => {
    expect(submittedValues).toStrictEqual([
      { key: "secret", kind: "secret", value: "acme-secret" },
    ]);
    expect(grants).toStrictEqual([
      { customConnectorId: connector.id, permissionNames: [] },
    ]);
    expect(screen.getByText("DeepWiki connected")).toBeInTheDocument();
  });
});

test("Let an MCP server discover authentication from a directed connection", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  const connectionId = "a0000000-0000-4000-a000-000000000095";
  let connected = false;
  let grants: AgentCustomConnectorGrant[] = [];
  const connector = mcpCustomConnector({
    displayName: "Discovery MCP",
    slug: "_discovery-mcp",
    fields: [],
    headerInjections: [],
    queryInjections: [],
    authMode: "automatic",
  });
  mockAccounts(() => {
    return connected
      ? [
          customConnectorAccount(connector.id, {
            id: connectionId,
            authMethod: "oauth",
          }),
        ]
      : [];
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [connector],
    });
  });
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, params, respond }) => {
      expect(params.id).toBe(connector.id);
      expect(body.account).toStrictEqual({ intent: "add" });
      connected = true;
      completedAttempts.set(oauthAttemptId, connectionId);
      return respond(200, {
        result: "authorization",
        oauthAttemptId,
        authorizationUrl: "https://mcp.discovery.test/authorize",
        connectionId,
      });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      expect(params.id).toBe(AGENT_ID);
      grants = body.grants;
      return respond(200, { grants });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = true;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);

  await setupPage({
    context,
    path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
  });

  await expect(
    screen.findByText("Okou needs Discovery MCP to proceed"),
  ).resolves.toBeVisible();
  click(getButtonByText("Connect"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Discovery MCP",
  });
  expect(dialog).toHaveTextContent(
    "Continue while Okou checks how this MCP server authenticates.",
  );
  click(getButtonByText("Continue", dialog));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://mcp.discovery.test/authorize",
    );
    expect(grants).toStrictEqual([
      { customConnectorId: connector.id, permissionNames: [] },
    ]);
    expect(screen.getByText("Discovery MCP connected")).toBeInTheDocument();
  });
});

test("Reconnect the exact manual custom-connector account", async () => {
  const connectionId = crypto.randomUUID();
  const connector = customConnector({
    displayName: "Acme Configured API",
    account: {
      id: connectionId,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
    },
  });
  const account = customConnectorAccount(connector.id, {
    id: connectionId,
    configuredFieldKeys: ["secret"],
  });
  mockAccounts(() => {
    return [account];
  });
  let submittedValues: readonly {
    readonly key: string;
    readonly kind: "secret" | "variable";
    readonly value: string;
  }[] = [];
  const definition = connector;
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [definition],
    });
  });
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ body, params, respond }) => {
      expect(params.id).toBe(connector.id);
      expect(body.account).toStrictEqual({
        intent: "reconnect",
        connectionId,
      });
      submittedValues = body.values;
      return respond(200, { ...connector, connectionId });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, respond }) => {
      return respond(200, { grants: body.grants });
    },
  );

  await setupPage({
    context,
    path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
  });

  await screen.findByText("Acme Configured API connected");
  click(getButtonByText("Reconnect"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Acme Configured API",
  });
  const secretInput = within(dialog).getByLabelText("Secret");
  expect(secretInput).toHaveAccessibleDescription("Required · Configured");
  await fill(secretInput, "replacement-secret");
  click(getButtonByText("Save"));

  await waitFor(() => {
    expect(submittedValues).toStrictEqual([
      {
        key: "secret",
        kind: "secret",
        value: "replacement-secret",
      },
    ]);
  });
});

test("Connect and authorize a custom OAuth connector", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  let connected = false;
  const connectionId = crypto.randomUUID();
  let grants: AgentCustomConnectorGrant[] = [];
  const connector = customConnector({
    slug: "_acme-oauth",
    displayName: "Acme OAuth",
    authMode: "oauth",
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "client-id",
      authorizationUrl: "https://acme.test/oauth/authorize",
      tokenUrl: "https://acme.test/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: ["read"],
      authorizationParams: {},
    },
  });
  mockAccounts(() => {
    return connected
      ? [
          customConnectorAccount(connector.id, {
            id: connectionId,
            authMethod: "oauth",
          }),
        ]
      : [];
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [connector],
    });
  });
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, params, respond }) => {
      expect(params.id).toBe(connector.id);
      expect(body.account).toStrictEqual({ intent: "add" });
      connected = true;
      completedAttempts.set(oauthAttemptId, connectionId);
      return respond(200, {
        result: "authorization",
        oauthAttemptId,
        authorizationUrl: "https://acme.test/oauth/authorize",
        connectionId,
      });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      expect(params.id).toBe(AGENT_ID);
      grants = body.grants;
      return respond(200, { grants });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = true;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);

  await setupPage({
    context,
    path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
  });

  const heading = await screen.findByText("Okou needs Acme OAuth to proceed");
  expect(heading).toBeInTheDocument();
  click(getButtonByText("Connect"));
  await screen.findByRole("dialog", { name: "Connect Acme OAuth" });
  click(getButtonByText("Continue"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe("https://acme.test/oauth/authorize");
    expect(grants).toStrictEqual([
      { customConnectorId: connector.id, permissionNames: [] },
    ]);
    expect(screen.getByText("Acme OAuth connected")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Connect Acme OAuth" }),
    ).toBeNull();
  });
});

test("Reconnect the exact custom OAuth account", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const siblingConnectionId = crypto.randomUUID();
  let grants: AgentCustomConnectorGrant[] = [];
  const connector = customConnector({
    slug: "_acme-oauth-reconnect",
    displayName: "Acme OAuth Reconnect",
    authMode: "oauth",
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "client-id",
      authorizationUrl: "https://acme.test/oauth/reconnect",
      tokenUrl: "https://acme.test/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: ["read"],
      authorizationParams: {},
    },
    account: {
      id: connectionId,
      missingRequiredFields: [],
    },
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [connector],
    });
  });
  const account = customConnectorAccount(connector.id, {
    id: connectionId,
    authMethod: "oauth",
  });
  mockAccounts(() => {
    return [account];
  });
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, params, respond }) => {
      expect(params.id).toBe(connector.id);
      expect(body.account).toStrictEqual({
        intent: "reconnect",
        connectionId,
      });
      completedAttempts.set(oauthAttemptId, connectionId);
      return respond(200, {
        result: "authorization",
        oauthAttemptId,
        authorizationUrl: "https://acme.test/oauth/reconnect",
        connectionId: siblingConnectionId,
      });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      expect(params.id).toBe(AGENT_ID);
      grants = body.grants;
      return respond(200, { grants });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = true;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);

  await setupPage({
    context,
    path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
  });

  await screen.findByText("Acme OAuth Reconnect connected");
  click(getButtonByText("Reconnect"));
  await screen.findByRole("dialog", {
    name: "Connect Acme OAuth Reconnect",
  });
  click(getButtonByText("Continue"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe("https://acme.test/oauth/reconnect");
    expect(grants).toStrictEqual([
      { customConnectorId: connector.id, permissionNames: [] },
    ]);
  });
});

test("Preserve existing agent permissions after connecting custom OAuth", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  let connected = false;
  const connectionId = crypto.randomUUID();
  let authorizationUpdates = 0;
  const authorizationRequested = context.mocks.deferred<void>();
  const releaseAuthorization = context.mocks.deferred<void>();
  const connector = customConnector({
    slug: "_acme-permissioned-oauth",
    displayName: "Acme Permissioned OAuth",
    authMode: "oauth",
    fields: [],
    permissionBundleRef: "builtin:feishu@1",
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "client-id",
      authorizationUrl: "https://acme.test/oauth/authorize",
      tokenUrl: "https://acme.test/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: ["read"],
      authorizationParams: {},
    },
  });
  mockAccounts(() => {
    return connected
      ? [
          customConnectorAccount(connector.id, {
            id: connectionId,
            authMethod: "oauth",
          }),
        ]
      : [];
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [connector],
    });
  });
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, params, respond }) => {
      expect(params.id).toBe(connector.id);
      expect(body.account).toStrictEqual({ intent: "add" });
      connected = true;
      completedAttempts.set(oauthAttemptId, connectionId);
      return respond(200, {
        result: "authorization",
        oauthAttemptId,
        authorizationUrl: "https://acme.test/oauth/authorize",
        connectionId,
      });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.get,
    async ({ params, respond }) => {
      expect(params.id).toBe(AGENT_ID);
      authorizationRequested.resolve();
      await releaseAuthorization.promise;
      const grants = [
        {
          customConnectorId: connector.id,
          permissionNames: ["messages:send-as-user"],
        },
      ];
      return respond(200, { grants });
    },
  );
  context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
    authorizationUpdates += 1;
    return respond(200, { grants: [] });
  });
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = true;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);

  await setupPage({
    context,
    path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
  });

  await screen.findByText("Okou needs Acme Permissioned OAuth to proceed");
  click(getButtonByText("Connect"));
  await screen.findByRole("dialog", {
    name: "Connect Acme Permissioned OAuth",
  });
  click(getButtonByText("Continue"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe("https://acme.test/oauth/authorize");
  });
  await authorizationRequested.promise;
  releaseAuthorization.resolve();
  await waitFor(() => {
    expect(
      screen.getByText("Acme Permissioned OAuth connected"),
    ).toBeInTheDocument();
  });
  expect(authorizationUpdates).toBe(0);
});

test("Start public OAuth from a directed connection link", async () => {
  let startedAgentId: string | undefined;
  let authorizeAgent: true | undefined;
  const { authWindow } = mockConnectorOauthStart({
    popupClosed: false,
    onStart: (agentId, requestedAuthorization) => {
      startedAgentId = agentId;
      authorizeAgent = requestedAuthorization;
    },
  });
  mockPublicConnectorStatus(
    catalogFixture({
      slug: "github",
      label: "Public GitHub",
      description: "Public GitHub description",
      icon: connectorIcon("github"),
      category: "engineering-team-execution",
      generation: [],
      tags: [],
      authMethods: [
        {
          id: "oauth",
          label: "Public OAuth",
          description: "Public OAuth description",
          grantKind: "auth-code",
          supportsRefresh: true,
          manualFields: [],
          startOptions: [],
        },
      ],
      permissionSummary: {
        hasPermissions: false,
        permissionCount: 0,
        hasCategories: false,
        hasDefaultPolicyOverrides: false,
      },
      singleAuthCodeAuthMethodId: "oauth",
      connectNotice: null,
    }),
  );

  await setupPage({
    context,
    path: `/connectors/github/connect?agentId=${AGENT_ID}`,
  });

  await waitFor(() => {
    expect(
      screen.getByText("Okou needs Public GitHub to proceed"),
    ).toBeInTheDocument();
  });
  click(getButtonByText("Connect"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/github/authorize",
    );
    expect(startedAgentId).toBe(AGENT_ID);
    expect(authorizeAgent).toBeTruthy();
  });
});

test("Connect a no-auth connector and continue the originating chat", async () => {
  let savedConnection: BuiltinConnectorResponse | null = null;
  mockPublicConnectorStatus(
    publicNoAuthConnectorStatus({
      slug: "stripe",
      label: "Public Stripe",
    }),
  );
  let connectCalls = 0;
  let visibleAgentAuthorizationUpdates = 0;
  const threadId = "00000000-0000-4000-a000-000000000101";
  const callbackPrompt = "Re-check Stripe, then continue";
  let continuationPrompt: string | null = null;
  context.mocks.api(
    builtinConnectorNoAuthGrantContract.connect,
    ({ body, params, respond }) => {
      connectCalls += 1;
      expect(params.connectorSlug).toBe("stripe");
      expect(body).toStrictEqual({
        account: { intent: "add" },
        authMethod: "api",
        agentId: AGENT_ID,
        authorizeAgent: true,
      });
      savedConnection = savedBuiltinResponse({
        id: crypto.randomUUID(),
        slug: "stripe",
        authMethod: body.authMethod,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      return respond(200, { connectionId: savedConnection.id });
    },
  );
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if ("prompt" in body) {
      continuationPrompt = body.prompt ?? null;
    }
    return respond(201, {
      threadId,
    });
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ body, respond }) => {
      visibleAgentAuthorizationUpdates += 1;
      return respond(200, {
        enabledConnectorSlugs: [...body.enabledConnectorSlugs],
      });
    },
  );
  await setupPage({
    context,
    path: `/connectors/stripe/connect?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`,
  });

  await waitFor(() => {
    expect(
      screen.getByText("Okou needs Public Stripe to proceed"),
    ).toBeInTheDocument();
  });
  click(getButtonByText("Connect"));

  await waitFor(() => {
    expect(connectCalls).toBe(1);
    expect(screen.getByText("Public Stripe connected")).toBeInTheDocument();
    expect(continuationPrompt).toBe(callbackPrompt);
  });
  expect(visibleAgentAuthorizationUpdates).toBe(0);
  expect(
    screen.queryByRole("dialog", { name: "Public Stripe" }),
  ).not.toBeInTheDocument();
});

test("Complete OpenID and continue the originating chat", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  context.mocks.data.connectors([]);
  const threadId = "00000000-0000-4000-a000-000000000102";
  const callbackPrompt = "Re-check Steam, then continue";
  let continuationPrompt: string | null = null;
  const { authWindow } = mockConnectorOpenIdStart({
    oauthAttemptId,
    popupClosed: false,
    onStart: () => {
      completedAttempts.set(
        oauthAttemptId,
        "00000000-0000-4000-8000-000000000001",
      );
      savedBuiltinResponse(
        connectedConnectorResponse({
          slug: "steam",
          authMethod: "openid",
          updatedAt: "2026-01-01T00:00:01Z",
        }),
      );
    },
  });
  mockPublicConnectorStatus(steamOpenIdConnectorStatus());
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: ["steam"] });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    continuationPrompt = body.prompt ?? null;
    return respond(201, {
      threadId,
    });
  });

  await setupPage({
    context,
    path: `/connectors/steam/connect?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`,
  });

  await waitFor(() => {
    expect(
      screen.getByText("Okou needs Public Steam to proceed"),
    ).toBeInTheDocument();
  });
  click(getButtonByText("Connect"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://openid.test/steam/authorize",
    );
    expect(screen.getByText("Public Steam connected")).toBeInTheDocument();
    expect(continuationPrompt).toBe(callbackPrompt);
  });
});

test.each(["configuration_incomplete", "configuration_invalid"] as const)(
  "Show the saved builtin account's %s reason in the connect dialog",
  async (reconnectReason) => {
    const account: ConnectorAccountConnection = {
      id: crypto.randomUUID(),
      target: { kind: "builtin", connectorSlug: "github" },
      authMethod: "api-token",
      displayName: null,
      isDefault: true,
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      connectionStatus: "reconnect-required",
      scopeMismatch: false,
      reconnectReason,
      missingRequiredFields: ["apiToken"],
      configuredFieldKeys: [],
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockAccounts(() => {
      return [account];
    });
    const connector = publicManualTokenConnectorStatus({
      slug: "github",
      label: "Public GitHub",
      placeholder: "github-token",
    });
    mockPublicConnectorStatus(
      catalogFixture({
        ...connector,
        authMethods: [
          ...connector.authMethods,
          {
            id: "oauth",
            label: "Public OAuth",
            description: null,
            grantKind: "auth-code",
            supportsRefresh: true,
            manualFields: [],
            startOptions: [],
          },
        ],
        account: {
          id: account.id,
          authMethod: account.authMethod,
          externalUsername: null,
          externalEmail: null,
          reconnectReason,
          connectionStatus: "reconnect-required",
        },
      }),
    );

    await setupPage({
      context,
      path: `/connectors/github/connect?agentId=${AGENT_ID}`,
    });
    await expect(
      screen.findByText("Okou needs Public GitHub to proceed"),
    ).resolves.toBeInTheDocument();
    click(getButtonByText("Connect"));
    const dialog = await screen.findByRole("dialog", { name: "Public GitHub" });
    expect(
      within(dialog).getByText(
        reconnectReason === "configuration_invalid"
          ? "Account status unavailable"
          : "Setup incomplete",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Connected")).not.toBeInTheDocument();
    expect(
      within(dialog).getByPlaceholderText("github-token"),
    ).toBeInTheDocument();
  },
);

test("Reconnect the expired public OAuth account", async () => {
  const connectionId = crypto.randomUUID();
  context.mocks.data.connectors([
    {
      ...connectedConnectorResponse({
        slug: "github",
        authMethod: "oauth",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      id: connectionId,
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    },
  ]);
  const connector = publicOAuthConnectorStatus({
    slug: "github",
    label: "Public GitHub",
    singleAuthCodeAuthMethodId: null,
  });
  mockPublicConnectorStatus(
    catalogFixture({
      ...connector,
      authMethods: [
        ...connector.authMethods,
        {
          id: "api-token",
          label: "Alternate API token",
          description: null,
          grantKind: "manual",
          supportsRefresh: false,
          manualFields: [
            {
              id: "apiToken",
              label: "Alternate API token",
              required: true,
              placeholder: "alternate-token",
              inputType: "password",
            },
          ],
          startOptions: [],
        },
      ],
      account: {
        id: connectionId,
        authMethod: "oauth",
        externalUsername: "mock-connected-account",
        externalEmail: null,
        reconnectReason: "authorization_expired_or_revoked",
        connectionStatus: "reconnect-required",
      },
    }),
  );
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);
  let oauthStarted = false;
  let startedConnectorSlug: string | null = null;
  let startedAccountIntent: string | null = null;
  let startedAuthMethod: string | null = null;
  let startedAgentId: string | null = null;
  let startedAuthorizeAgent = false;
  let startedConnectionId: string | null = null;
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, params, respond }) => {
      oauthStarted = true;
      startedConnectorSlug = params.connectorSlug;
      startedAccountIntent = body.account.intent;
      startedAuthMethod = body.authMethod;
      startedAgentId = body.agentId ?? null;
      startedAuthorizeAgent = body.authorizeAgent === true;
      if (body.account.intent === "reconnect") {
        startedConnectionId = body.account.connectionId;
      }
      return respond(200, {
        authorizationUrl: "https://oauth.test/github/reconnect",
        oauthAttemptId,
      });
    },
  );

  await setupPage({
    context,
    path: `/connectors/github/connect?agentId=${AGENT_ID}`,
  });

  await screen.findByText("Okou needs Public GitHub to proceed");
  expect(screen.queryByText("Public GitHub connected")).not.toBeInTheDocument();
  click(getButtonByText("Connect"));
  const dialog = await screen.findByRole("dialog", {
    name: "Public GitHub",
  });
  expect(within(dialog).getByText("Connection expired")).toBeInTheDocument();
  expect(
    within(dialog).queryByLabelText("Alternate API token"),
  ).not.toBeInTheDocument();
  click(getButtonByText("Reconnect", dialog));

  await waitFor(() => {
    expect(oauthStarted).toBeTruthy();
  });
  expect(startedConnectorSlug).toBe("github");
  expect(startedAccountIntent).toBe("reconnect");
  expect(startedAuthMethod).toBe("oauth");
  expect(startedAgentId).toBe(AGENT_ID);
  expect(startedAuthorizeAgent).toBeTruthy();
  expect(startedConnectionId).toBe(connectionId);

  context.mocks.data.connectors([
    {
      ...connectedConnectorResponse({
        slug: "github",
        authMethod: "oauth",
        updatedAt: "2026-01-01T00:00:01Z",
      }),
      id: connectionId,
    },
  ]);
  completedAttempts.set(oauthAttemptId, connectionId);
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "github",
  });
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Public GitHub" }),
    ).not.toBeInTheDocument();
  });
});

test("Reconnect the exact account and continue the originating chat only after success", async () => {
  mockPublicConnectorStatus(
    publicManualTokenConnectorStatus({
      slug: "axiom",
      label: "Public Axiom",
      placeholder: "public-xaat",
    }),
  );
  const connectionId = "00000000-0000-4000-a000-000000000701";
  const threadId = "00000000-0000-4000-a000-000000000103";
  const callbackPrompt = "Re-check the work Axiom account, then continue";
  let submittedAccount: unknown = null;
  let continuationPrompt: string | null = null;
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, query, respond }) => {
      expect(params.connectionId).toBe(connectionId);
      expect(query).toStrictEqual({ kind: "builtin", connectorSlug: "axiom" });
      return respond(200, {
        id: connectionId,
        target: { kind: "builtin", connectorSlug: "axiom" },
        authMethod: "api-token",
        displayName: "Work Axiom",
        isDefault: false,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: [],
        connectionStatus:
          submittedAccount === null ? "reconnect-required" : "connected",
        missingRequiredFields: [],
        configuredFieldKeys: ["apiToken"],
        reconnectReason:
          submittedAccount === null ? "authorization_expired_or_revoked" : null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
  );
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ body, respond }) => {
      submittedAccount = body.account;
      return respond(200, { connectionId: connectionId });
    },
  );
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    continuationPrompt = body.prompt ?? null;
    return respond(201, {
      threadId,
    });
  });
  await setupPage({
    context,
    path: `/connectors/axiom/reconnect/${connectionId}?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`,
  });

  await waitFor(() => {
    expect(getButtonByText("Reconnect")).toBeInTheDocument();
  });
  expect(continuationPrompt).toBeNull();
  click(getButtonByText("Reconnect"));

  const dialog = await screen.findByRole("dialog", { name: "Public Axiom" });
  await fill(within(dialog).getByPlaceholderText("public-xaat"), "xaat-work");
  expect(continuationPrompt).toBeNull();
  click(getButtonByText("Save"));

  await waitFor(() => {
    expect(submittedAccount).toStrictEqual({
      intent: "reconnect",
      connectionId,
    });
    expect(continuationPrompt).toBe(callbackPrompt);
  });
});

test("Connect a manual grant and continue the originating chat", async () => {
  let savedConnection: BuiltinConnectorResponse | null = null;
  mockPublicConnectorStatus(
    publicManualTokenConnectorStatus({
      slug: "axiom",
      label: "Public Axiom",
      placeholder: "public-xaat",
    }),
  );
  let submittedValues: Record<string, string> | null = null;
  const threadId = "00000000-0000-4000-a000-000000000103";
  const callbackPrompt = "Re-check Axiom, then continue";
  const callbackStarted = context.mocks.deferred<void>();
  const releaseCallback = context.mocks.deferred<void>();
  let continuationPrompt: string | null = null;
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ body, params, respond }) => {
      expect(params.connectorSlug).toBe("axiom");
      expect(body.agentId).toBe(AGENT_ID);
      submittedValues = body.values;
      savedConnection = savedBuiltinResponse({
        id: crypto.randomUUID(),
        slug: "axiom",
        authMethod: body.authMethod,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      return respond(200, { connectionId: savedConnection.id });
    },
  );
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    continuationPrompt = body.prompt ?? null;
    callbackStarted.resolve();
    await releaseCallback.promise;
    return respond(201, {
      threadId,
    });
  });
  await setupPage({
    context,
    path: `/connectors/axiom/connect?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`,
  });

  await waitFor(() => {
    expect(
      screen.getByText("Okou needs Public Axiom to proceed"),
    ).toBeInTheDocument();
  });
  click(getButtonByText("Connect"));

  const axiomDialog = await screen.findByRole("dialog", {
    name: "Public Axiom",
  });
  await fill(
    within(axiomDialog).getByPlaceholderText("public-xaat"),
    "xaat-directed-connect",
  );
  click(getButtonByText("Save"));

  await callbackStarted.promise;
  await expect(
    screen.findByText("Public Axiom connected"),
  ).resolves.toBeInTheDocument();
  expect(axiomDialog).toBeInTheDocument();
  releaseCallback.resolve();

  await waitFor(() => {
    expect(submittedValues).toStrictEqual({
      apiToken: "xaat-directed-connect",
    });
    expect(continuationPrompt).toBe(callbackPrompt);
    expect(
      screen.queryByRole("dialog", { name: "Public Axiom" }),
    ).not.toBeInTheDocument();
  });
});
