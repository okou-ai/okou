import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";

// The publisher and sync writer own this schema-versioned raw JSON shape.
// Readers neither recompile publisher semantics nor recompute content hashes.
export type ImmutableConnectorCatalogHeader = Omit<
  ConnectorCatalogArtifact,
  "connectors"
>;
export type ImmutableConnectorCatalogEntry = ConnectorCatalogArtifactConnector;
export type ImmutableConnectorCatalogAuthMethods =
  ConnectorCatalogArtifactConnector["authMethods"];
export type ImmutableConnectorCatalogFirewall =
  ConnectorCatalogArtifactConnector["firewall"];
