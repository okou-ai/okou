import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  CONNECTOR_ACCOUNT_LIST_MAX_LIMIT,
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
  type ConnectorAccountConnection,
  type ConnectorAccountInspectionResult,
  type ConnectorAccountSelection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectedConnectorsContract,
  type ConnectedConnectors,
} from "@okouai/api-contracts/contracts/connected-connectors";
import {
  builtinConnectorsMainContract,
  builtinConnectorManualGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  type PublicConnectorCatalogListResponse,
  type PublicConnectorCatalogPermissionDetail,
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  CONNECTOR_CHECK_AWS_CONTEXT_HEADER,
  CONNECTOR_CHECK_AWS_CONTEXT_INSUFFICIENT,
  connectorCheckContract,
  connectorCheckDiagnosticResultSchema,
  connectorCheckTargetAwareDiagnosticResultSchema,
  type ConnectorCheckDiagnosticResult,
  type ConnectorCheckRequestBody,
  type ConnectorCheckTargetAwareDiagnosticResult,
} from "@okouai/api-contracts/contracts/connector-check";
import {
  customConnectorPermissionBundleSchema,
  type CreateCustomConnectorBody,
  type CustomConnectorPermissionBundleResponse,
  type UpdateCustomConnectorBody,
  customConnectorByIdContract,
  customConnectorsContract,
  customConnectorListResponseSchema,
  customConnectorResponseSchema,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  mcpConnectorOAuthReauthorizationResponseSchema,
  type McpConnectorOAuthReauthorizationResponse,
  mcpConnectorListResponseSchema,
  mcpConnectorsContract,
  type McpConnector,
} from "@okouai/api-contracts/contracts/mcp-connectors";
import {
  type BuiltinConnectorListResponse as ApiBuiltinConnectorListResponse,
  type BuiltinConnectorResponse,
} from "@okouai/api-contracts/contracts/connector-schemas";
import { handleManagementError } from "../../management-input";
import {
  getConnectorManagementConfig,
  parseConnectorManagementResponse,
} from "./connector-management";
import { getClientConfig, handleError } from "../core/client-factory";

export type BuiltinConnector = BuiltinConnectorResponse;
type BuiltinConnectorListResponse = ApiBuiltinConnectorListResponse;
export type ConnectorCatalogItem =
  PublicConnectorCatalogListResponse["connectors"][number];
export type ConnectorCatalogStatus = PublicConnectorCatalogStatusItem;
type ConnectorCatalogListResponse = PublicConnectorCatalogListResponse;
export type ConnectorCatalogPermissionDetail =
  PublicConnectorCatalogPermissionDetail;

export type ConnectorAccountConnectionsResult =
  | {
      readonly state: "available";
      readonly connections: readonly ConnectorAccountConnection[];
      readonly defaultConnection: ConnectorAccountConnection | null;
    }
  | { readonly state: "unavailable" };

export type BuiltinConnectorManualGrantAccountMutation = Extract<
  ConnectorAccountMutationIntent,
  { intent: "add" | "reconnect" }
>;

export async function listConnectedConnectors(): Promise<ConnectedConnectors> {
  const config = await getClientConfig();
  const client = initClient(connectedConnectorsContract, {
    ...config,
    validateResponse: true,
  });
  const result = await client.list({ headers: {} });
  if (result.status !== 200) {
    handleError(result, "Failed to read connected connector directory");
  }
  return result.body;
}

export async function listConnectorAccountConnections(
  target: ConnectorAccountTarget,
  search?: string,
  options: { readonly includeScopeMismatch?: boolean } = {},
): Promise<ConnectorAccountConnectionsResult> {
  const config = await getClientConfig();
  const client = initClient(connectorAccountsContract, {
    ...config,
    validateResponse: true,
  });
  const connections: ConnectorAccountConnection[] = [];
  let cursor: string | null = null;
  let defaultConnection: ConnectorAccountConnection | null = null;

  do {
    const paging = {
      limit: CONNECTOR_ACCOUNT_LIST_MAX_LIMIT,
      ...(cursor ? { cursor } : {}),
      ...(search ? { search } : {}),
    };
    const query =
      target.kind === "builtin"
        ? {
            ...paging,
            kind: "builtin" as const,
            connectorSlug: target.connectorSlug,
            ...(options.includeScopeMismatch
              ? { includeScopeMismatch: "true" as const }
              : {}),
          }
        : {
            ...paging,
            kind: "custom" as const,
            customConnectorId: target.customConnectorId,
          };
    const result = await client.connections({ headers: {}, query });
    if (result.status === 404) {
      return { state: "unavailable" };
    }
    if (result.status !== 200) {
      handleError(result, "Failed to list connector accounts");
    }
    if (cursor === null) defaultConnection = result.body.defaultConnection;
    connections.push(...result.body.connections);
    cursor = result.body.nextCursor;
  } while (cursor);

  return { state: "available", connections, defaultConnection };
}

export async function inspectConnectorAccounts(
  selections: readonly ConnectorAccountSelection[],
): Promise<readonly ConnectorAccountInspectionResult[]> {
  const config = await getClientConfig();
  const client = initClient(connectorAccountsContract, {
    ...config,
    validateResponse: true,
  });
  const result = await client.inspect({
    headers: {},
    body: { selections: [...selections] },
  });
  if (result.status === 200) {
    return result.body.results;
  }
  handleError(result, "Failed to inspect connector accounts for this run");
}

/** List all connectors for the authenticated user. */
export async function listBuiltinConnectors(): Promise<BuiltinConnectorListResponse> {
  const config = await getClientConfig();
  const client = initClient(builtinConnectorsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connectors");
}

export async function listConnectorCatalog(): Promise<ConnectorCatalogListResponse> {
  const config = await getClientConfig();
  const client = initClient(connectorCatalogContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connector catalog");
}

export async function getConnectorCatalogDetail(
  connectorSlug: string,
): Promise<ConnectorCatalogStatus | null> {
  const config = await getClientConfig();
  const client = initClient(connectorCatalogContract, {
    ...config,
    validateResponse: true,
  });
  const result = await client.get({ params: { connectorSlug } });
  if (result.status === 404) return null;
  if (result.status !== 200)
    handleError(result, "Failed to read connector catalog detail");
  if (result.body.connector.slug !== connectorSlug) {
    throw new Error("Connector catalog response identity mismatch.");
  }
  return result.body.connector;
}

export async function getConnectorCatalogPermissions(
  connectorSlug: string,
): Promise<ConnectorCatalogPermissionDetail | null> {
  const config = await getClientConfig();
  const client = initClient(connectorCatalogContract, config);

  const result = await client.permissions({
    params: { connectorSlug },
  });

  if (result.status === 200) {
    const permissions = result.body.permissions;
    if (permissions.connectorSlug !== connectorSlug) {
      throw new Error(
        `Permission metadata connector slug mismatch: expected ${connectorSlug}, got ${permissions.connectorSlug}`,
      );
    }
    return permissions;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(
    result,
    `Failed to get connector permission metadata for "${connectorSlug}"`,
  );
}

function normalizeBuiltinDiagnostic(
  diagnostic: ConnectorCheckDiagnosticResult,
): ConnectorCheckTargetAwareDiagnosticResult {
  if ("connector" in diagnostic) {
    const { connectorSlug, ...identity } = diagnostic.connector;
    return {
      ...diagnostic,
      connector: {
        ...identity,
        target: { kind: "builtin", connectorSlug },
      },
    };
  }
  if (diagnostic.outcome === "ambiguous") {
    return {
      ...diagnostic,
      candidates: diagnostic.candidates.map(({ connectorSlug, label }) => {
        return { target: { kind: "builtin", connectorSlug }, label };
      }),
    };
  }
  return diagnostic;
}

export interface ConnectorCheckWithContext {
  readonly diagnostic: ConnectorCheckTargetAwareDiagnosticResult;
  readonly awsContextIncomplete: boolean;
}

export async function diagnoseConnectorCheckWithContext(
  request: ConnectorCheckRequestBody,
): Promise<ConnectorCheckWithContext> {
  const config = await getClientConfig();
  const client = initClient(connectorCheckContract, {
    ...config,
    validateResponse: true,
  });

  const result = await client.check({ body: request });

  if (result.status === 200) {
    const diagnostic =
      "target" in request || "includeCustomConnectors" in request
        ? connectorCheckTargetAwareDiagnosticResultSchema.parse(result.body)
        : normalizeBuiltinDiagnostic(
            connectorCheckDiagnosticResultSchema.parse(result.body),
          );
    return {
      diagnostic,
      awsContextIncomplete:
        result.headers.get(CONNECTOR_CHECK_AWS_CONTEXT_HEADER) ===
        CONNECTOR_CHECK_AWS_CONTEXT_INSUFFICIENT,
    };
  }

  handleError(result, "Failed to diagnose connector");
}

export async function diagnoseConnectorCheck(
  request: ConnectorCheckRequestBody,
): Promise<ConnectorCheckTargetAwareDiagnosticResult> {
  return (await diagnoseConnectorCheckWithContext(request)).diagnostic;
}

export async function connectBuiltinConnectorManualGrant(
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
  account: BuiltinConnectorManualGrantAccountMutation,
  values: Record<string, string>,
) {
  const config = await getConnectorManagementConfig();
  const client = initClient(builtinConnectorManualGrantContract, config);

  const result = await client.connect({
    params: { connectorSlug },
    body: {
      account,
      authMethod,
      values,
    },
  });

  if (result.status === 200) {
    return parseConnectorManagementResponse(
      builtinConnectorManualGrantContract.connect.responses[200],
      result.body,
    );
  }

  handleManagementError(result, "Failed to connect connector account");
}

export async function listCustomConnectors(): Promise<
  CustomConnectorResponse[]
> {
  const config = await getConnectorManagementConfig();
  const client = initClient(customConnectorsContract, config);

  const result = await client.list({ headers: {} });
  if (result.status === 200) {
    return parseConnectorManagementResponse(
      customConnectorListResponseSchema,
      result.body,
    ).connectors;
  }

  handleManagementError(result, "Failed to list custom connectors");
}

export async function listRunMcpConnectors(): Promise<McpConnector[]> {
  const config = await getClientConfig();
  const client = initClient(mcpConnectorsContract, {
    ...config,
    validateResponse: true,
  });
  const result = await client.list({ headers: {} });
  if (result.status === 200) {
    return mcpConnectorListResponseSchema.parse(result.body).connectors;
  }
  handleError(result, "Failed to list MCP connectors for this run");
}

export async function reauthorizeRunMcpConnectorOAuth(
  target: ConnectorAccountTarget,
  scopes: readonly string[],
  signal: AbortSignal,
): Promise<McpConnectorOAuthReauthorizationResponse> {
  const config = await getClientConfig();
  const client = initClient(mcpConnectorsContract, config);
  const result = await client.reauthorizeOAuth({
    headers: {},
    body: { target, scopes: [...scopes] },
    fetchOptions: { signal },
  });
  if (result.status === 200) {
    return mcpConnectorOAuthReauthorizationResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to reauthorize MCP OAuth scopes");
}

export async function createCustomConnector(
  body: CreateCustomConnectorBody,
): Promise<CustomConnectorResponse> {
  const config = await getConnectorManagementConfig();
  const client = initClient(customConnectorsContract, config);

  const result = await client.create({ body, headers: {} });
  if (result.status === 201) {
    return parseConnectorManagementResponse(
      customConnectorResponseSchema,
      result.body,
    );
  }

  handleManagementError(result, "Failed to create custom connector");
}

export async function getCustomConnector(
  id: string,
): Promise<CustomConnectorResponse | null> {
  const config = await getConnectorManagementConfig();
  const client = initClient(customConnectorByIdContract, config);

  const result = await client.get({ params: { id }, headers: {} });
  if (result.status === 200) {
    const connector = parseConnectorManagementResponse(
      customConnectorResponseSchema,
      result.body,
    );
    if (connector.id !== id)
      throw new Error("Custom connector response identity mismatch.");
    return connector;
  }
  if (result.status === 404) {
    return null;
  }

  handleManagementError(result, "Failed to get custom connector");
}

export async function updateCustomConnector(
  id: string,
  body: UpdateCustomConnectorBody,
): Promise<CustomConnectorResponse> {
  const config = await getConnectorManagementConfig();
  const client = initClient(customConnectorByIdContract, config);

  const result = await client.update({ params: { id }, body, headers: {} });
  if (result.status === 200) {
    const connector = parseConnectorManagementResponse(
      customConnectorResponseSchema,
      result.body,
    );
    if (connector.id !== id)
      throw new Error("Custom connector response identity mismatch.");
    return connector;
  }

  handleManagementError(result, "Failed to update custom connector");
}

export async function deleteCustomConnector(id: string): Promise<void> {
  const client = initClient(
    customConnectorByIdContract,
    await getConnectorManagementConfig(),
  );
  const result = await client.delete({ params: { id }, headers: {} });
  if (result.status !== 204) {
    handleManagementError(result, "Failed to delete custom connector");
  }
}

export async function getCustomConnectorPermissionBundle(
  id: string,
): Promise<CustomConnectorPermissionBundleResponse | null> {
  const config = await getClientConfig();
  const client = initClient(customConnectorByIdContract, config);
  const result = await client.permissions({ params: { id }, headers: {} });
  if (result.status === 200) {
    return customConnectorPermissionBundleSchema.parse(result.body);
  }
  if (result.status === 404) {
    return null;
  }
  handleError(result, `Failed to get custom connector permissions for "${id}"`);
}
