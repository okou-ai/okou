import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";

export interface ExternalCatalogIdentity {
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
}

/** Captured catalog facts needed for per-slug runtime materialization. */
export interface ConnectorCatalogLookup {
  readonly identity: ExternalCatalogIdentity;
  readonly connectorBySlug: ReadonlyMap<
    string,
    ConnectorCatalogArtifactConnector
  >;
  readonly filteredMethodKeys: ReadonlySet<string>;
}

/** Full ordered entries and header for consumers that genuinely scan the catalog. */
export interface ConnectorCatalogView extends ConnectorCatalogLookup {
  readonly artifact: ConnectorCatalogArtifact;
}

/** Existing load observations, kept separate from lookup-only consumers. */
export interface ConnectorCatalogRuntimeView extends ConnectorCatalogView {
  readonly catalogRawSize: number;
  readonly catalogCompressedSize: number;
}
