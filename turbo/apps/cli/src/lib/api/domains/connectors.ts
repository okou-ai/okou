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
  builtinConnectorManualGrantContract,
  builtinConnectorsBySlugContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogListResponse,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusItem,
  type PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorCheckContract,
  connectorCheckDiagnosticResultSchema,
  connectorCheckTargetAwareDiagnosticResultSchema,
  type ConnectorCheckDiagnosticResult,
  type ConnectorCheckRequestBody,
  type ConnectorCheckTargetAwareDiagnosticResult,
} from "@okouai/api-contracts/contracts/connector-check";
import {
  customConnectorByIdContract,
  customConnectorsContract,
  customConnectorListResponseSchema,
  customConnectorPermissionBundleSchema,
  customConnectorResponseSchema,
  type CreateCustomConnectorBody,
  type CustomConnectorPermissionBundleResponse,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  mcpConnectorOAuthReauthorizationResponseSchema,
  type McpConnectorOAuthReauthorizationResponse,
  mcpConnectorListResponseSchema,
  mcpConnectorsContract,
  type McpConnector,
} from "@okouai/api-contracts/contracts/mcp-connectors";
import type {
  BuiltinConnectorListResponse as ApiBuiltinConnectorListResponse,
  BuiltinConnectorResponse,
} from "@okouai/api-contracts/contracts/connector-schemas";
import { getClientConfig, handleError } from "../core/client-factory";

export type BuiltinConnector = BuiltinConnectorResponse;
type BuiltinConnectorListResponse = ApiBuiltinConnectorListResponse;
export type ConnectorCatalogItem =
  PublicConnectorCatalogListResponse["connectors"][number];
export type ConnectorCatalogStatus = PublicConnectorCatalogStatusItem;
type ConnectorCatalogListResponse = PublicConnectorCatalogListResponse;
type ConnectorCatalogStatusResponse = PublicConnectorCatalogStatusResponse;
export type ConnectorCatalogPermissionDetail =
  PublicConnectorCatalogPermissionDetail;

type ConnectorAccountConnectionsResult =
  | {
      readonly state: "available";
      readonly connections: readonly ConnectorAccountConnection[];
    }
  | { readonly state: "unavailable" };

export type BuiltinConnectorManualGrantAccountMutation = Extract<
  ConnectorAccountMutationIntent,
  { intent: "add" | "reconnect" }
>;

export async function listConnectorAccountConnections(
  target: ConnectorAccountTarget,
  search?: string,
): Promise<ConnectorAccountConnectionsResult> {
  const config = await getClientConfig();
  const client = initClient(connectorAccountsContract, {
    ...config,
    validateResponse: true,
  });
  const connections: ConnectorAccountConnection[] = [];
  let cursor: string | null = null;

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
    connections.push(...result.body.connections);
    cursor = result.body.nextCursor;
  } while (cursor);

  return { state: "available", connections };
}

export async function inspectConnectorAccounts(
  selections: readonly ConnectorAccountSelection[],
): Promise<readonly ConnectorAccountInspectionResult[] | null> {
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
  if (result.status === 404) {
    return null;
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

export async function listConnectorCatalogStatus(): Promise<ConnectorCatalogStatusResponse> {
  const config = await getClientConfig();
  const client = initClient(connectorCatalogContract, config);

  const result = await client.status({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list connector catalog status");
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

export async function diagnoseConnectorCheck(
  request: ConnectorCheckRequestBody,
): Promise<ConnectorCheckTargetAwareDiagnosticResult> {
  const config = await getClientConfig();
  const client = initClient(connectorCheckContract, {
    ...config,
    validateResponse: true,
  });

  const result = await client.check({ body: request });

  if (result.status === 200) {
    if ("target" in request || "includeCustomConnectors" in request) {
      return connectorCheckTargetAwareDiagnosticResultSchema.parse(result.body);
    }
    return normalizeBuiltinDiagnostic(
      connectorCheckDiagnosticResultSchema.parse(result.body),
    );
  }

  handleError(result, "Failed to diagnose connector");
}

/**
 * Get a connector by slug.
 * Returns null if not connected (404 response).
 */
export async function getBuiltinConnector(
  connectorSlug: ConnectorSlug,
): Promise<BuiltinConnector | null> {
  const config = await getClientConfig();
  const client = initClient(builtinConnectorsBySlugContract, config);

  const result = await client.get({
    params: { connectorSlug },
  });

  if (result.status === 200) {
    return result.body;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(result, `Failed to get connector "${connectorSlug}"`);
}

export async function connectBuiltinConnectorManualGrant(
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
  account: BuiltinConnectorManualGrantAccountMutation,
  values: Record<string, string>,
): Promise<BuiltinConnector> {
  const config = await getClientConfig();
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
    return result.body;
  }

  handleError(result, `Failed to connect connector "${connectorSlug}"`);
}

export async function listCustomConnectors(): Promise<
  CustomConnectorResponse[]
> {
  const config = await getClientConfig();
  const client = initClient(customConnectorsContract, config);

  const result = await client.list({ headers: {} });
  if (result.status === 200) {
    return customConnectorListResponseSchema.parse(result.body).connectors;
  }

  handleError(result, "Failed to list custom connectors");
}

export async function listRunMcpConnectors(): Promise<McpConnector[]> {
  const config = await getClientConfig();
  const client = initClient(mcpConnectorsContract, config);

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
  const config = await getClientConfig();
  const client = initClient(customConnectorsContract, config);

  const result = await client.create({ body, headers: {} });
  if (result.status === 201) {
    return customConnectorResponseSchema.parse(result.body);
  }

  handleError(result, "Failed to create custom connector");
}

export async function getCustomConnector(
  id: string,
): Promise<CustomConnectorResponse | null> {
  const config = await getClientConfig();
  const client = initClient(customConnectorByIdContract, config);

  const result = await client.get({ params: { id }, headers: {} });
  if (result.status === 200) {
    return customConnectorResponseSchema.parse(result.body);
  }
  if (result.status === 404) {
    return null;
  }

  handleError(result, `Failed to get custom connector "${id}"`);
}

export async function updateCustomConnector(
  id: string,
  body: UpdateCustomConnectorBody,
): Promise<CustomConnectorResponse> {
  const config = await getClientConfig();
  const client = initClient(customConnectorByIdContract, config);

  const result = await client.update({ params: { id }, body, headers: {} });
  if (result.status === 200) {
    return customConnectorResponseSchema.parse(result.body);
  }

  handleError(result, `Failed to update custom connector "${id}"`);
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
