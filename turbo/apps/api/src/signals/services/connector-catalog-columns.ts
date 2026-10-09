import { connectorCatalogEntries } from "@okouai/db/runtime/connector-catalog";
import type { ConnectorCatalogArtifactConnector } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import type { ConnectorCatalogPermissionSummary } from "@okouai/connectors/connector-catalog/entry-columns";

// Narrow projections share the required column contract with the writer.
const entry = connectorCatalogEntries;

export const connectorCatalogCompatibilityColumns = Object.freeze({
  slug: entry.slug,
  authMethods: entry.authMethods,
  mcp: entry.mcp,
});

const metadataColumns = Object.freeze({
  ...connectorCatalogCompatibilityColumns,
  label: entry.label,
  description: entry.description,
  category: entry.category,
  icon: entry.icon,
  tags: entry.tags,
  generation: entry.generation,
});

export const connectorCatalogDisplayColumns = Object.freeze({
  ...metadataColumns,
  permissionSummary: entry.permissionSummary,
});

export const connectorCatalogRuntimeColumns = Object.freeze({
  ...metadataColumns,
  skill: entry.skill,
  firewall: entry.firewall,
});

type CompatibilityConnector = Pick<
  ConnectorCatalogArtifactConnector,
  "slug" | "authMethods" | "mcp"
>;

export type ConnectorCatalogDisplayConnector = Pick<
  ConnectorCatalogArtifactConnector,
  | "slug"
  | "label"
  | "description"
  | "category"
  | "icon"
  | "tags"
  | "generation"
  | "authMethods"
  | "mcp"
> & { readonly permissionSummary: ConnectorCatalogPermissionSummary };

type ColumnRow<T extends CompatibilityConnector> = Omit<T, "mcp"> & {
  readonly mcp: NonNullable<T["mcp"]> | null;
};

export function materializeConnectorCatalogCompatibilityRow(
  row: ColumnRow<CompatibilityConnector>,
): CompatibilityConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}

export function materializeConnectorCatalogDisplayRow(
  row: ColumnRow<ConnectorCatalogDisplayConnector>,
): ConnectorCatalogDisplayConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}

export function materializeConnectorCatalogRuntimeRow(
  row: ColumnRow<ConnectorCatalogArtifactConnector>,
): ConnectorCatalogArtifactConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}
