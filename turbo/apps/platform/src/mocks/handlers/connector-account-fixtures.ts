import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import { z } from "zod";
import {
  connectorCatalogReaderContract,
  type PublicConnectorCatalogStatusReaderItem as PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog-readers";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorOAuthConfig,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  customConnectorReaderResponseSchema,
  type CustomConnectorReaderResponse as CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connector-readers";

type CustomConnectorHttpResponse = Extract<
  CustomConnectorResponse,
  { kind: "http" }
>;
type CustomConnectorMcpResponse = Extract<
  CustomConnectorResponse,
  { kind: "mcp" }
>;

const catalogMetadataSchema =
  connectorCatalogReaderContract.get.responses[200].shape.connector.omit({
    connected: true,
    connection: true,
    connectionStatus: true,
    setupStatus: true,
    scopeMismatch: true,
    authMethodSupportsRefresh: true,
    tokenExpiresAt: true,
  });

/** Account scenarios stay outside catalog/definition HTTP response fixtures. */
const accounts = new WeakMap<object, ConnectorAccountConnection>();

export function connectorFixtureAccount(definition: object) {
  return accounts.get(definition);
}

export interface BuiltinFixtureAccount {
  readonly connection?:
    | (Partial<Pick<ConnectorAccountConnection, "id">> &
        Pick<
          ConnectorAccountConnection,
          | "authMethod"
          | "externalUsername"
          | "externalEmail"
          | "reconnectReason"
        >)
    | null;
  readonly connected?: boolean;
  readonly connectionStatus?:
    "connected" | "not-connected" | "scope-mismatch" | "reconnect-required";
  readonly setupStatus?: ConnectorAccountConnection["setupStatus"] | null;
  readonly scopeMismatch?: boolean;
  readonly tokenExpiresAt?: string | null;
}

export interface CustomFixtureAccount {
  readonly connected?: boolean;
  readonly connectedAccountId?: string;
  readonly connectedAccountUpdatedAt?: string;
  readonly missingRequiredFields?: readonly string[];
  readonly configuredFieldKeys?: readonly string[];
}

export type HttpFixtureOverrides = Partial<
  Omit<CustomConnectorHttpResponse, "authMode" | "oauthConfig">
> &
  CustomFixtureAccount & {
    readonly authMode?: "manual" | "none" | "oauth";
    readonly oauthConfig?: CustomConnectorOAuthConfig;
  };
export type McpFixtureOverrides = Partial<
  Omit<CustomConnectorMcpResponse, "authMode" | "oauthConfig">
> &
  CustomFixtureAccount & {
    readonly authMode?: "manual" | "none" | "oauth" | "automatic";
    readonly oauthConfig?: CustomConnectorOAuthConfig;
  };

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

function accountBase() {
  return {
    displayName: null,
    isDefault: true,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function catalogFixture(
  input: PublicConnectorCatalogStatusItem & BuiltinFixtureAccount,
): PublicConnectorCatalogStatusItem {
  const metadata = catalogMetadataSchema.parse(input);
  if (input.connection || input.connected) {
    accounts.set(metadata, {
      ...accountBase(),
      ...input.connection,
      id: input.connection?.id ?? crypto.randomUUID(),
      target: { kind: "builtin", connectorSlug: input.slug },
      authMethod:
        input.connection?.authMethod ?? input.authMethods[0]?.id ?? "oauth",
      scopeMismatch: input.scopeMismatch ?? false,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      setupStatus: input.setupStatus ?? "complete",
      connectionStatus:
        input.connectionStatus === "reconnect-required"
          ? "reconnect-required"
          : "connected",
    });
  }
  return metadata;
}

function rememberCustomAccount(
  definition: CustomConnectorResponse,
  fixture: CustomFixtureAccount,
) {
  if (
    !isIntegrationManagedCustomConnector(definition) &&
    (fixture.connected || fixture.connectedAccountId)
  ) {
    accounts.set(definition, {
      ...accountBase(),
      id: fixture.connectedAccountId ?? "66666666-6666-4666-8666-666666666666",
      target: { kind: "custom", customConnectorId: definition.id },
      authMethod: definition.authMode,
      connectionStatus: "connected",
      setupStatus: fixture.missingRequiredFields?.length
        ? "incomplete"
        : "complete",
      missingRequiredFields: [...(fixture.missingRequiredFields ?? [])],
      configuredFieldKeys: [...(fixture.configuredFieldKeys ?? [])],
    });
  }
}

const customFixtureAccountSchema = z.object({
  connected: z.boolean().optional(),
  connectedAccountId: z.uuid().optional(),
  missingRequiredFields: z.array(z.string()).optional(),
  configuredFieldKeys: z.array(z.string()).optional(),
});

export function httpConnectorFixture(
  input: unknown,
): CustomConnectorHttpResponse {
  const definition = customDefinitionFixture(input);
  if (definition.kind !== "http") {
    throw new Error("Expected an HTTP connector fixture");
  }
  rememberCustomAccount(definition, customFixtureAccountSchema.parse(input));
  return definition;
}

export function mcpConnectorFixture(
  input: unknown,
): CustomConnectorMcpResponse {
  const definition = customDefinitionFixture(input);
  if (definition.kind !== "mcp") {
    throw new Error("Expected an MCP connector fixture");
  }
  rememberCustomAccount(definition, customFixtureAccountSchema.parse(input));
  return definition;
}

function customDefinitionFixture(input: unknown): CustomConnectorResponse {
  const definition = customConnectorReaderResponseSchema.parse(input);
  if (isIntegrationManagedCustomConnector(definition)) {
    return definition;
  }
  const {
    connected: _connected,
    connectedAccountId: _connectedAccountId,
    connectedAccountUpdatedAt: _connectedAccountUpdatedAt,
    missingRequiredFields: _missingRequiredFields,
    configuredFieldKeys: _configuredFieldKeys,
    ...metadata
  } = definition;
  return metadata;
}
