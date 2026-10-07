import { and, eq, inArray } from "drizzle-orm";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import type { ImmutableConnectorCatalogEntry } from "@okouai/db/jsonb-contracts/immutable-connector-catalog";
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
import {
  catalogIdentityFromCapture,
  type ExternalCatalogIdentity,
} from "./connector-catalog-view";

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

type CatalogCompatibilityEntry = Pick<
  ImmutableConnectorCatalogEntry,
  "slug" | "authMethods" | "mcp"
>;

interface CatalogSlugRow<
  Entry extends CatalogCompatibilityEntry = ImmutableConnectorCatalogEntry,
> {
  readonly current: {
    readonly schemaVersion: number;
    readonly hash: string;
  };
  readonly entry: Entry | null;
}

interface CatalogSlugIdentityRow extends CatalogSlugRow {
  readonly current: CatalogSlugRow["current"] & {
    readonly schemaVersion: number;
    readonly hash: string;
  };
}

function currentFromRows<Row extends CatalogSlugRow<CatalogCompatibilityEntry>>(
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

/**
 * Missing entries are omitted here, as if the slug were never authorized.
 */
export function connectorCatalogSlugSourceFromRows<
  Entry extends CatalogCompatibilityEntry,
>(
  rows: readonly CatalogSlugRow<Entry>[],
  requestedSlugs: readonly ConnectorSlug[],
): ConnectorCatalogSlugSource<Entry> {
  currentFromRows(rows);
  const entries = new Map(
    rows.flatMap(({ entry }) => {
      return entry === null ? [] : [[entry.slug, entry] as const];
    }),
  );
  const connectors = [...new Set(requestedSlugs)].flatMap((slug) => {
    const entry = entries.get(slug);
    return entry === undefined ? [] : [entry];
  });
  const filtered = evaluateConnectorCatalogCompatibility({
    artifact: { connectors },
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

/** Runtime slugs without an entry are omitted, like metadata-only slugs. */
export function connectorCatalogSlugRuntimeFromRows(
  rows: readonly CatalogSlugRow[],
  args: {
    readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
    readonly metadataConnectorSlugs?: readonly ConnectorSlug[];
  },
) {
  const runtimeConnectorSlugs = args.runtimeConnectorSlugs;
  const metadataConnectorSlugs = args.metadataConnectorSlugs ?? [];
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
  return catalogIdentityFromCapture(
    current,
    connectorCatalogExecutableCapabilityState().digest,
  );
}
