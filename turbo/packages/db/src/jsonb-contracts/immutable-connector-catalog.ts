import type { ConnectorCatalogArtifactConnector } from "@okouai/connectors/connector-catalog/artifacts/artifacts";

// The publisher and sync writer own this schema-versioned raw JSON shape.
// Readers neither recompile publisher semantics nor recompute content hashes.
export type ImmutableConnectorCatalogEntry = ConnectorCatalogArtifactConnector;
