import { connectorCatalogSource } from "./connector-catalog-source";
import type { ConnectorCatalogRuntimeConnector } from "./connector-catalog-columns";

export interface ExternalCatalogIdentity {
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
}

/** Catalog-wide routing and auth facts; per-slug execution reads also include skills. */
export interface ConnectorCatalogLookup {
  readonly identity: ExternalCatalogIdentity;
  readonly connectorBySlug: ReadonlyMap<
    string,
    ConnectorCatalogRuntimeConnector
  >;
  readonly filteredMethodKeys: ReadonlySet<string>;
}

/** Catalog-wide entries read from the immutable entry rows. */
export interface ConnectorCatalogView extends ConnectorCatalogLookup {
  readonly artifact: {
    readonly connectors: readonly ConnectorCatalogRuntimeConnector[];
  };
}

export type ConnectorCatalogRuntimeView = ConnectorCatalogView;

/** Keep the persisted/Runner v1 shape readable without retaining version identity. */
export function catalogIdentityFromCapture(
  capture: { readonly schemaVersion: number; readonly hash: string },
  capabilityDigest: string,
): ExternalCatalogIdentity {
  return {
    sourceId: connectorCatalogSource().sourceId,
    schemaVersion: capture.schemaVersion,
    // Legacy wire field, no longer used for identity comparisons.
    catalogVersion: capture.hash,
    catalogDigest: capture.hash,
    capabilityDigest,
  };
}
