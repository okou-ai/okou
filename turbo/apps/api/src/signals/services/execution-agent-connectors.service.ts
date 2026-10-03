import type { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import type { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import type { CustomConnectorExecutionDefinition } from "./custom-connector-definition-selection";
import { normaliseCustomConnectorRow } from "./custom-connector.service";

export interface AgentConnectorSelectionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

export interface SelectedCustomConnector {
  readonly customConnectorId: string;
  readonly connectorSlug: string;
  readonly permissionNames: readonly string[];
  readonly storageVersion: number;
  readonly skillStorageVersionId: string | null;
  readonly permissionBundleRef: string | null;
  readonly isMcp: boolean;
}

export interface AgentConnectorSelection {
  readonly builtinConnectorSlugs: readonly string[];
  readonly customConnectors: readonly SelectedCustomConnector[];
  readonly customConnectorDefinitions: readonly CustomConnectorExecutionDefinition[];
}

export function agentConnectorSelectionFromRows(
  builtinRows: readonly { readonly connectorSlug: string }[],
  customRows: readonly (SelectedDefinitionRow & {
    readonly permissionNames: readonly string[];
  })[],
): AgentConnectorSelection {
  const customConnectors = customRows
    .map((row): SelectedCustomConnector => {
      return {
        customConnectorId: row.connector.id,
        connectorSlug: row.connector.slug,
        permissionNames: [...row.permissionNames].sort(),
        storageVersion: row.connector.storageVersion,
        skillStorageVersionId: row.connector.skillStorageVersionId,
        permissionBundleRef: row.connector.permissionBundleRef,
        isMcp: row.connector.mcpEndpoint !== null,
      };
    })
    .sort((a, b) => {
      return a.customConnectorId.localeCompare(b.customConnectorId);
    });
  return {
    builtinConnectorSlugs: builtinRows
      .map((row) => {
        return row.connectorSlug;
      })
      .sort(),
    customConnectors,
    customConnectorDefinitions: customRows.map(executionDefinitionFromRow),
  };
}

type SelectedDefinitionRow = {
  readonly connector: typeof orgCustomConnectors.$inferSelect;
  readonly oauthConfig:
    | typeof orgCustomConnectorOauthConfigs.$inferSelect
    | null;
};

function executionDefinitionFromRow(
  row: SelectedDefinitionRow,
): CustomConnectorExecutionDefinition {
  const definition = normaliseCustomConnectorRow(
    row.connector,
    row.oauthConfig,
  );
  const config = definition.oauthConfig;
  const shared = {
    id: definition.id,
    orgId: definition.orgId,
    slug: definition.slug,
    displayName: definition.displayName,
    fields: definition.fields,
    headerInjections: definition.headerInjections,
    queryInjections: definition.queryInjections,
    authMode: definition.authMode,
    skillMarkdown: definition.skillMarkdown,
    skillStorageVersionId: definition.skillStorageVersionId,
    storageVersion: definition.storageVersion,
    oauthConfig:
      config === null
        ? null
        : {
            providerAdapter: config.providerAdapter,
            clientId: config.clientId,
            encryptedClientSecret: config.encryptedClientSecret,
            authorizationUrl: config.authorizationUrl,
            tokenUrl: config.tokenUrl,
            tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
            pkceMethod: config.pkceMethod,
            scopes: config.scopes,
            authorizationParams: config.authorizationParams,
          },
  };
  return definition.kind === "http"
    ? {
        ...shared,
        kind: "http",
        prefixTemplates: definition.prefixTemplates,
        permissionBundleRef: definition.permissionBundleRef,
      }
    : {
        ...shared,
        kind: "mcp",
        endpoint: definition.endpoint,
        transport: definition.transport,
      };
}
