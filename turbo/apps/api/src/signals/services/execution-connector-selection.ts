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
  readonly hasSkill: boolean;
  readonly skillContentBundle: ContentBundle | null;
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
    .map(({ connector }): SelectedCustomConnector => {
      return {
        customConnectorId: connector.id,
        connectorSlug: connector.slug,
        hasSkill: connector.hasSkill,
        skillContentBundle: connector.skillContentBundle,
        permissionBundleRef: connector.permissionBundleRef,
        isMcp: connector.mcpEndpoint !== null,
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
    Pick<SelectedCustomConnector, "hasSkill" | "skillContentBundle">;
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
