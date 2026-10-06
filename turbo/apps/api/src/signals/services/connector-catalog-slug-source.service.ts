import { and, eq, inArray } from "drizzle-orm";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import type {
  ImmutableConnectorCatalogHeader,
  ImmutableConnectorCatalogEntry,
} from "@okouai/db/jsonb-contracts/immutable-connector-catalog";
import { SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  ExternalConnectorCatalogUnavailableError,
  type ConnectorCatalogSlugSource,
} from "./connector-catalog-external-reader.service";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
} from "./connector-catalog-compatibility.service";
import {
  materializeConnectorRuntimeLookup,
  uniqueSortedConnectorSlugs,
} from "./connector-catalog-runtime.service";
import { connectorCatalogSource } from "./connector-catalog-source";
import type { ExternalCatalogIdentity } from "./connector-catalog-view";

/** Pure predicates: the reader executes its SQL on its own connection/transaction. */
export function connectorCatalogCurrentWhere() {
  return eq(
    connectorCatalog.schemaVersion,
    SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  );
}

export function connectorCatalogSlugJoin(slugs: readonly ConnectorSlug[]) {
  return and(
    eq(connectorCatalogEntries.hash, connectorCatalog.hash),
    inArray(connectorCatalogEntries.slug, [...new Set(slugs)]),
  );
}

interface CatalogSlugRow {
  readonly current: {
    readonly header: ImmutableConnectorCatalogHeader;
    readonly entrySlugs: readonly string[];
  };
  readonly entry: {
    readonly slug: string;
    readonly payload: ImmutableConnectorCatalogEntry;
  } | null;
}

interface CatalogSlugIdentityRow extends CatalogSlugRow {
  readonly current: CatalogSlugRow["current"] & {
    readonly schemaVersion: number;
    readonly hash: string;
  };
}

function currentFromRows<Row extends CatalogSlugRow>(
  rows: readonly Row[],
): Row["current"] {
  const current = rows[0]?.current;
  if (current === undefined) {
    throw new ExternalConnectorCatalogUnavailableError(
      "missing_current_identity",
    );
  }
  return current;
}

/** Unknown slugs are absent; a listed entry missing in storage is unavailable. */
export function connectorCatalogSlugSourceFromRows(
  rows: readonly CatalogSlugRow[],
  requestedSlugs: readonly ConnectorSlug[],
): ConnectorCatalogSlugSource {
  const current = currentFromRows(rows);
  const manifest = new Set(current.entrySlugs);
  const entries = new Map(
    rows.flatMap(({ entry }) => {
      return entry === null ? [] : [[entry.slug, entry.payload] as const];
    }),
  );
  const connectors = [...new Set(requestedSlugs)].flatMap((slug) => {
    if (!manifest.has(slug)) {
      return [];
    }
    const entry = entries.get(slug);
    if (entry === undefined) {
      throw new ExternalConnectorCatalogUnavailableError(
        "missing_manifest_entry",
      );
    }
    return [entry];
  });
  const filtered = evaluateConnectorCatalogCompatibility({
    artifact: { ...current.header, connectors },
    capability: connectorCatalogExecutableCapabilityState(),
  });
  return {
    connectors,
    filteredMethodKeys: new Set(
      filtered.map((method) => {
        return `${method.connectorSlug}\0${method.authMethodId}`;
      }),
    ),
  };
}

export function connectorCatalogSlugRuntimeFromRows(
  rows: readonly CatalogSlugRow[],
  runtimeConnectorSlugs: readonly ConnectorSlug[],
  metadataConnectorSlugs: readonly ConnectorSlug[] = [],
) {
  const source = connectorCatalogSlugSourceFromRows(rows, [
    ...runtimeConnectorSlugs,
    ...metadataConnectorSlugs,
  ]);
  return materializeConnectorRuntimeLookup({
    ...source,
    runtimeConnectorSlugs: uniqueSortedConnectorSlugs(runtimeConnectorSlugs),
    metadataConnectorSlugs: uniqueSortedConnectorSlugs(metadataConnectorSlugs),
  });
}

/** Only the existing Pi recapture comparison consumes this matching identity. */
export function connectorCatalogSlugIdentityFromRows(
  rows: readonly CatalogSlugIdentityRow[],
): ExternalCatalogIdentity {
  const current = currentFromRows(rows);
  return {
    sourceId: connectorCatalogSource().sourceId,
    schemaVersion: current.schemaVersion,
    catalogVersion: current.header.catalogVersion,
    catalogDigest: current.hash,
    capabilityDigest: connectorCatalogExecutableCapabilityState().digest,
  };
}
