import { connectorCatalogSource } from "./connector-catalog-source";
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

/**
 * Catalog-wide entries plus the pointer row's category labels, which public
 * discovery still returns to App clients.
 */
export interface ConnectorCatalogView extends ConnectorCatalogLookup {
  readonly artifact: Pick<
    ConnectorCatalogArtifact,
    "categoryMetadata" | "connectors"
  >;
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
