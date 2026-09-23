import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorCatalogArtifactConnector } from "@okouai/connectors/connector-catalog/artifacts/artifacts";

import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import {
  loadAcceptedConnectorCatalogSnapshot,
  type ConnectorCatalogSlugSource,
} from "./connector-catalog-external-reader.service";
import {
  countConnectorCatalogRuntimeProjectionRows,
  queryConnectorCatalogRuntimeProjectionRows,
  readConnectorCatalogRuntimeProjectionIdentity,
  validateConnectorCatalogRuntimeProjectionRows,
  type ConnectorCatalogRuntimeProjectionIdentity,
  type ConnectorCatalogRuntimeProjectionReadyIdentity,
  type ConnectorCatalogRuntimeProjectionValidationTiming,
} from "./connector-catalog-runtime-projection.service";

// Validated projection rows are immutable for one projection generation, so
// they are cached per connector. The bound keeps a process from holding the
// whole catalog when many different slugs are read.
const SLUG_SOURCE_CACHE_CAPACITY = 256;

interface SlugSourceCache {
  identityKey: string | undefined;
  // `null` records a slug the complete projection confirmed does not exist.
  readonly connectors: Map<
    ConnectorSlug,
    ConnectorCatalogArtifactConnector | null
  >;
}

const slugSourceCache = singleton((): SlugSourceCache => {
  return { identityKey: undefined, connectors: new Map() };
});

function untimedValidation(): ConnectorCatalogRuntimeProjectionValidationTiming {
  return {
    measureParse: (operation) => {
      return operation();
    },
    measureDigest: (operation) => {
      return operation();
    },
  };
}

function projectionIdentityKey(
  identity: ConnectorCatalogRuntimeProjectionIdentity,
): string {
  return [
    identity.projectionSetId,
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
    identity.projectionVersion,
    identity.connectorCount,
  ].join("\0");
}

function cacheFor(
  projection: ConnectorCatalogRuntimeProjectionReadyIdentity,
): SlugSourceCache {
  const cache = slugSourceCache();
  const key = projectionIdentityKey(projection.identity);
  if (cache.identityKey !== key) {
    cache.identityKey = key;
    cache.connectors.clear();
  }
  return cache;
}

function remember(
  cache: SlugSourceCache,
  connectorSlug: ConnectorSlug,
  connector: ConnectorCatalogArtifactConnector | null,
): void {
  cache.connectors.delete(connectorSlug);
  cache.connectors.set(connectorSlug, connector);
  if (cache.connectors.size > SLUG_SOURCE_CACHE_CAPACITY) {
    const [oldest] = cache.connectors.keys();
    if (oldest !== undefined) {
      cache.connectors.delete(oldest);
    }
  }
}

async function loadFromCompleteCatalog(
  db: ReadonlyDb,
  connectorSlugs: readonly ConnectorSlug[],
): Promise<ConnectorCatalogSlugSource> {
  const snapshot = await loadAcceptedConnectorCatalogSnapshot(db);
  return {
    connectors: connectorSlugs.flatMap((connectorSlug) => {
      const connector = snapshot.connectorBySlug.get(connectorSlug);
      return connector === undefined ? [] : [connector];
    }),
    filteredMethodKeys: snapshot.filteredMethodKeys,
  };
}

type ProjectedRead =
  | {
      readonly kind: "ready";
      readonly connectors: ReadonlyMap<
        ConnectorSlug,
        ConnectorCatalogArtifactConnector | null
      >;
    }
  | { readonly kind: "fallback" };

async function readProjectedConnectors(args: {
  readonly db: ReadonlyDb;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectorSlugs: readonly ConnectorSlug[];
}): Promise<ProjectedRead> {
  const rows = await queryConnectorCatalogRuntimeProjectionRows(args);
  const read = validateConnectorCatalogRuntimeProjectionRows({
    rows,
    connectorSlugs: args.connectorSlugs,
    timing: untimedValidation(),
  });
  if (read.kind === "fallback") {
    return { kind: "fallback" };
  }
  const connectors = new Map<
    ConnectorSlug,
    ConnectorCatalogArtifactConnector | null
  >(
    read.connectors.map((connector) => {
      return [connector.slug, connector] as const;
    }),
  );
  if (read.missingConnectorSlugs.length === 0) {
    return { kind: "ready", connectors };
  }
  // A slug without a row is only unknown when the generation is complete and
  // still current; otherwise the set may be mid-replacement.
  const actualCount = await countConnectorCatalogRuntimeProjectionRows({
    db: args.db,
    identity: args.projection.identity,
  });
  if (actualCount !== args.projection.identity.connectorCount) {
    return { kind: "fallback" };
  }
  const latest = await readConnectorCatalogRuntimeProjectionIdentity(args.db);
  if (
    latest.kind === "fallback" ||
    projectionIdentityKey(latest.projection.identity) !==
      projectionIdentityKey(args.projection.identity)
  ) {
    return { kind: "fallback" };
  }
  for (const connectorSlug of read.missingConnectorSlugs) {
    connectors.set(connectorSlug, null);
  }
  return { kind: "ready", connectors };
}

/**
 * Loads only the requested connectors from the per-connector runtime
 * projection. When the projection is not ready, incomplete, unstable, or
 * invalid, it falls back to the complete accepted catalog, matching the
 * runtime selection's fallback.
 */
export async function loadConnectorCatalogSlugSource(
  db: ReadonlyDb,
  requestedConnectorSlugs: readonly ConnectorSlug[],
): Promise<ConnectorCatalogSlugSource> {
  const connectorSlugs = [...new Set(requestedConnectorSlugs)];
  if (connectorSlugs.length === 0) {
    return { connectors: [], filteredMethodKeys: new Set() };
  }
  const identity = await readConnectorCatalogRuntimeProjectionIdentity(db);
  if (identity.kind === "fallback") {
    return await loadFromCompleteCatalog(db, connectorSlugs);
  }
  const key = projectionIdentityKey(identity.projection.identity);
  const cache = cacheFor(identity.projection);
  const cached = new Map<
    ConnectorSlug,
    ConnectorCatalogArtifactConnector | null
  >();
  for (const connectorSlug of connectorSlugs) {
    const connector = cache.connectors.get(connectorSlug);
    if (connector !== undefined) {
      cached.set(connectorSlug, connector);
    }
  }
  const uncachedSlugs = connectorSlugs.filter((connectorSlug) => {
    return !cached.has(connectorSlug);
  });
  const fetched =
    uncachedSlugs.length === 0
      ? { kind: "ready" as const, connectors: new Map() }
      : await readProjectedConnectors({
          db,
          projection: identity.projection,
          connectorSlugs: uncachedSlugs,
        });
  if (fetched.kind === "fallback") {
    return await loadFromCompleteCatalog(db, connectorSlugs);
  }
  // Another request may have moved the cache to a newer generation while rows
  // were read; only remember rows under the identity they were read with.
  const cacheable = slugSourceCache().identityKey === key;
  const connectors = connectorSlugs.flatMap((connectorSlug) => {
    const connector =
      cached.get(connectorSlug) ??
      fetched.connectors.get(connectorSlug) ??
      null;
    if (cacheable) {
      remember(cache, connectorSlug, connector);
    }
    return connector === null ? [] : [connector];
  });
  return {
    connectors,
    filteredMethodKeys: identity.projection.filteredMethodKeys,
  };
}
