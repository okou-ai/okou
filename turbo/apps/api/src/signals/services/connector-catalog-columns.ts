import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import type { ConnectorCatalogPermissionSummary } from "@okouai/connectors/connector-catalog/entry-columns";
import { asc, eq } from "drizzle-orm";

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

const catalogSearchColumns = Object.freeze({
  ...connectorCatalogCompatibilityColumns,
  label: entry.label,
  description: entry.description,
});

export const connectorCatalogRuntimeColumns = Object.freeze({
  ...metadataColumns,
  skill: entry.skill,
  firewall: entry.firewall,
});

// Catalog-wide diagnostics and change detection do not consume display copy or skills.
const catalogRuntimeColumns = Object.freeze({
  ...connectorCatalogCompatibilityColumns,
  label: entry.label,
  firewall: entry.firewall,
});

export function acceptedCatalogIdentityReadPlan() {
  return {
    columns: {
      schemaVersion: connectorCatalog.schemaVersion,
      hash: connectorCatalog.hash,
    },
    condition: eq(
      connectorCatalog.schemaVersion,
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    ),
  };
}

export function acceptedCatalogEntriesReadPlan(catalogDigest: string) {
  return {
    displayColumns: connectorCatalogDisplayColumns,
    searchColumns: catalogSearchColumns,
    runtimeColumns: catalogRuntimeColumns,
    condition: eq(connectorCatalogEntries.hash, catalogDigest),
    orderBy: asc(connectorCatalogEntries.slug),
  };
}

type CompatibilityConnector = Pick<
  ConnectorCatalogArtifactConnector,
  "slug" | "authMethods" | "mcp"
>;

export type ConnectorCatalogRuntimeConnector = Pick<
  ConnectorCatalogArtifactConnector,
  "slug" | "authMethods" | "mcp" | "label" | "firewall"
>;

export type ConnectorCatalogSearchConnector = Pick<
  ConnectorCatalogArtifactConnector,
  "slug" | "authMethods" | "mcp" | "label" | "description"
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

export function materializeConnectorCatalogSearchRow(
  row: ColumnRow<ConnectorCatalogSearchConnector>,
): ConnectorCatalogSearchConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}

export function materializeConnectorCatalogRuntimeRow(
  row: ColumnRow<ConnectorCatalogArtifactConnector>,
): ConnectorCatalogArtifactConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}

export function materializeConnectorCatalogRuntimeMetadataRow(
  row: ColumnRow<ConnectorCatalogRuntimeConnector>,
): ConnectorCatalogRuntimeConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}
