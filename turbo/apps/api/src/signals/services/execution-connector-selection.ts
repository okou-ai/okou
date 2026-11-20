import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type {
  CustomConnectorExecutionDefinitionRow,
  CustomConnectorExecutionDefinition,
  CustomConnectorExecutionOAuthConfig,
} from "./custom-connector-definition-selection";
import { normaliseCustomConnectorConnectionDefinition } from "./custom-connector.service";

interface SelectedCustomConnector {
  readonly customConnectorId: string;
  readonly connectorSlug: string;
  readonly skillStorageVersionId: string | null;
  readonly skillContentBundle: ContentBundle | null;
  readonly skillContentBundleSourceVersionId: string | null;
  readonly permissionBundleRef: string | null;
  readonly isMcp: boolean;
}

export interface RunConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
}

export interface ExecutionConnectorSelection {
  readonly scope: RunConnectorScope;
  readonly customConnectors: readonly SelectedCustomConnector[];
  readonly customConnectorDefinitions: readonly CustomConnectorExecutionDefinition[];
}

export function executionConnectorSelectionFromRows(
  builtinRows: readonly { readonly connectorSlug: string }[],
  customRows: readonly SelectedDefinitionRow[],
): ExecutionConnectorSelection {
  const allowedConnectorSlugs = builtinRows
    .flatMap(({ connectorSlug }) => {
      const parsed = connectorSlugSchema.safeParse(connectorSlug);
      return parsed.success ? [parsed.data] : [];
    })
    .sort();
  const customConnectors = customRows
    .map((row): SelectedCustomConnector => {
      return {
        customConnectorId: row.connector.id,
        connectorSlug: row.connector.slug,
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
    scope: {
      allowedConnectorSlugs,
      allowedCustomConnectorIds: customConnectors.map((connector) => {
        return connector.customConnectorId;
      }),
    },
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
