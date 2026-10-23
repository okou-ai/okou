import type {
  ConnectorAccountConnection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  publicConnectorCatalogStatusItemSchema,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseSchema,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
  type CustomConnectorResponse,
  type CustomConnectorOAuthConfig,
  type IntegrationManagedCustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";

export type FixtureAccountOverrides = Partial<
  Omit<ConnectorAccountConnection, "target">
>;
export interface ConnectorFixtureAccount {
  readonly account?: FixtureAccountOverrides;
}
type ManagedFixtureAuth = Partial<
  Pick<
    IntegrationManagedCustomConnectorResponse,
    | "connected"
    | "connectedAccountId"
    | "connectedAccountUpdatedAt"
    | "missingRequiredFields"
    | "configuredFieldKeys"
  >
> & {
  readonly authMode: "oauth";
  readonly oauthConfig: CustomConnectorOAuthConfig & {
    readonly providerAdapter: "feishu";
  };
};
export type HttpFixtureOverrides = Partial<
  Omit<CustomConnectorHttpResponse, keyof ManagedFixtureAuth>
> &
  ConnectorFixtureAccount &
  (
    | {
        readonly authMode?: "manual" | "none" | "oauth";
        readonly oauthConfig?: CustomConnectorOAuthConfig;
      }
    | ManagedFixtureAuth
  );
export type McpFixtureOverrides = Partial<
  Omit<CustomConnectorMcpResponse, keyof ManagedFixtureAuth>
> &
  ConnectorFixtureAccount &
  (
    | {
        readonly authMode?: "manual" | "none" | "oauth" | "automatic";
        readonly oauthConfig?: CustomConnectorOAuthConfig;
      }
    | ManagedFixtureAuth
  );

/** Account scenarios are explicit and stay outside definition HTTP responses. */
const accounts = new WeakMap<object, ConnectorAccountConnection>();
export function connectorFixtureAccount(definition: object) {
  return accounts.get(definition);
}
export function requireConnectorFixtureAccount(definition: object) {
  const account = accounts.get(definition);
  if (!account) {
    throw new Error("Fixture must define the operated connector account");
  }
  return account;
}
export function customConnectorCompletionFixture<
  T extends CustomConnectorResponse,
>(definition: T) {
  return {
    ...definition,
    connectionId: requireConnectorFixtureAccount(definition).id,
  };
}
export function connectorAccountFixture(
  target: ConnectorAccountTarget,
  overrides: FixtureAccountOverrides = {},
): ConnectorAccountConnection {
  return {
    id: crypto.randomUUID(),
    authMethod: target.kind === "builtin" ? "oauth" : "manual",
    displayName: null,
    isDefault: true,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(target.kind === "builtin" ? { scopeMismatch: false } : {}),
    ...overrides,
    target,
  };
}
export function catalogFixture(
  input: PublicConnectorCatalogStatusItem & ConnectorFixtureAccount,
): PublicConnectorCatalogStatusItem {
  const metadata = publicConnectorCatalogStatusItemSchema.parse(input);
  if (input.account) {
    accounts.set(
      metadata,
      connectorAccountFixture(
        { kind: "builtin", connectorSlug: input.slug },
        input.account,
      ),
    );
  }
  return metadata;
}
export function httpConnectorFixture(
  input: Record<string, unknown> & ConnectorFixtureAccount,
): CustomConnectorHttpResponse {
  const definition = customConnectorHttpResponseSchema.parse(input);
  if (input.account) {
    accounts.set(
      definition,
      connectorAccountFixture(
        { kind: "custom", customConnectorId: definition.id },
        {
          id: "66666666-6666-4666-8666-666666666666",
          authMethod: definition.authMode,
          ...input.account,
        },
      ),
    );
  }
  return definition;
}
export function mcpConnectorFixture(
  input: Record<string, unknown> & ConnectorFixtureAccount,
): CustomConnectorMcpResponse {
  const definition = customConnectorMcpResponseSchema.parse(input);
  if (input.account) {
    accounts.set(
      definition,
      connectorAccountFixture(
        { kind: "custom", customConnectorId: definition.id },
        {
          id: "66666666-6666-4666-8666-666666666666",
          authMethod: definition.authMode,
          ...input.account,
        },
      ),
    );
  }
  return definition;
}
