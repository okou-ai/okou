import type { ConnectorCatalogPermissionSummary } from "@okouai/connectors/connector-catalog/entry-columns";
import type { ConnectorCatalogArtifactConnector } from "@okouai/connectors/connector-catalog/artifacts/artifacts";

// The publisher and sync writer own this schema-versioned raw JSON shape.
// Readers neither recompile publisher semantics nor recompute content hashes.
// Application-owned permission summaries are derived when preparing entries.
export type ImmutableConnectorCatalogEntry = ConnectorCatalogArtifactConnector;

export type ImmutableConnectorCatalogIcon =
  ConnectorCatalogArtifactConnector["icon"];
export type ImmutableConnectorCatalogAuthMethods =
  ConnectorCatalogArtifactConnector["authMethods"];
export type ImmutableConnectorCatalogMcp = NonNullable<
  ConnectorCatalogArtifactConnector["mcp"]
>;
export type ImmutableConnectorCatalogSkill =
  ConnectorCatalogArtifactConnector["skill"];
export type ImmutableConnectorCatalogFirewall =
  ConnectorCatalogArtifactConnector["firewall"];
export type ImmutableConnectorCatalogPermissionSummary =
  ConnectorCatalogPermissionSummary;
