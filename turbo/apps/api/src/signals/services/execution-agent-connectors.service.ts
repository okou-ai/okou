import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import type {
  CustomConnectorExecutionDefinitionRow,
  CustomConnectorExecutionDefinition,
  CustomConnectorExecutionOAuthConfig,
} from "./custom-connector-definition-selection";
import { normaliseCustomConnectorConnectionDefinition } from "./custom-connector.service";

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
  readonly skillContentBundle: ContentBundle | null;
  readonly skillContentBundleSourceVersionId: string | null;
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
        skillContentBundle: row.connector.skillContentBundle,
        skillContentBundleSourceVersionId:
          row.connector.skillContentBundleSourceVersionId,
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
  readonly connector: CustomConnectorExecutionDefinitionRow &
    Pick<
      SelectedCustomConnector,
      "skillContentBundle" | "skillContentBundleSourceVersionId"
    >;
  readonly oauthConfig: CustomConnectorExecutionOAuthConfig | null;
};

function executionDefinitionFromRow(
  row: SelectedDefinitionRow,
): CustomConnectorExecutionDefinition {
  const definition = normaliseCustomConnectorConnectionDefinition(
    row.connector,
    row.oauthConfig,
  );
  const shared = {
    ...(definition.networkBinding
      ? { networkBinding: definition.networkBinding }
      : {}),
    id: definition.id,
    orgId: definition.orgId,
    slug: definition.slug,
    displayName: definition.displayName,
    fields: definition.fields,
    headerInjections: definition.headerInjections,
    queryInjections: definition.queryInjections,
    authMode: definition.authMode,
    skillStorageVersionId: row.connector.skillStorageVersionId,
    storageVersion: definition.storageVersion,
    oauthConfig: definition.oauthConfig,
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
