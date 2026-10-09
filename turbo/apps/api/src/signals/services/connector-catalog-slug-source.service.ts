import { and, eq, inArray, sql } from "drizzle-orm";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
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
  materializeConnectorRuntimeAuthLookup,
  materializeConnectorRuntimeLookup,
  uniqueSortedConnectorSlugs,
  type ConnectorRuntimeAuthLookup,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import {
  createAcceptedConnectorServerFirewallCatalogFromConnectors,
  selectConnectorServerFirewalls,
  type ConnectorServerFirewallSelection,
} from "./connector-server-firewall-catalog.service";
import {
  connectorCatalogCompatibilityColumns,
  connectorCatalogRuntimeColumns,
  materializeConnectorCatalogCompatibilityRow,
  materializeConnectorCatalogRuntimeRow,
} from "./connector-catalog-columns";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { db$, type ReadonlyDb } from "../external/db";
import { command, computed } from "ccstate";
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

/** The catalog identity captured with these rows. */
export function connectorCatalogSlugIdentityFromRows(
  rows: readonly CatalogSlugRow[],
): ExternalCatalogIdentity {
  const current = currentFromRows(rows);
  return catalogIdentityFromCapture(
    current,
    connectorCatalogExecutableCapabilityState().digest,
  );
}

/**
 * Whether each named slug has an entry at the current hash. Reads the pointer
 * and entry slugs only; a missing pointer fails like a whole-catalog read.
 */
export async function loadCurrentConnectorCatalogSlugs(
  db: ReadonlyDb,
  connectorSlugs: readonly string[],
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({
      current: { schemaVersion: connectorCatalog.schemaVersion },
      slug: connectorCatalogEntries.slug,
    })
    .from(connectorCatalog)
    .leftJoin(connectorCatalogEntries, connectorCatalogSlugJoin(connectorSlugs))
    .where(connectorCatalogCurrentWhere());
  if (rows.length === 0) {
    throw new ExternalConnectorCatalogUnavailableError(
      "missing_current_identity",
    );
  }
  return new Set(
    rows.flatMap((row) => {
      return row.slug === null ? [] : [row.slug];
    }),
  );
}

export interface ConnectorRuntimeAuthSelection extends ConnectorRuntimeAuthLookup {
  /** Only `firewallConnectorSlugs`; no other entry reads its firewall. */
  readonly serverFirewalls: ConnectorServerFirewallSelection;
}

/**
 * Captures the current pointer and the named entries in one statement. Every
 * slug reads its auth methods and MCP descriptor; label and firewall rules are
 * read only for `firewallConnectorSlugs`. Missing entries are omitted, as they
 * are absent from a whole-catalog snapshot.
 */
export function connectorRuntimeAuthSelectionReadPlan(args: {
  readonly connectorSlugs: readonly string[];
  readonly firewallConnectorSlugs?: readonly ConnectorSlug[];
}) {
  const firewallConnectorSlugs = uniqueSortedConnectorSlugs(
    args.firewallConnectorSlugs ?? [],
  );
  const requestedConnectorSlugs = [
    ...args.connectorSlugs,
    ...firewallConnectorSlugs,
  ];
  const firewallEntry = inArray(connectorCatalogEntries.slug, [
    ...firewallConnectorSlugs,
  ]);
  return {
    columns: {
      current: {
        schemaVersion: connectorCatalog.schemaVersion,
        hash: connectorCatalog.hash,
      },
      entry: {
        slug: connectorCatalogCompatibilityColumns.slug,
        authMethods: connectorCatalogCompatibilityColumns.authMethods,
        mcp: connectorCatalogCompatibilityColumns.mcp,
        label:
          sql`CASE WHEN ${firewallEntry} THEN ${connectorCatalogRuntimeColumns.label} END`.mapWith(
            nullableDriverValueDecoder(connectorCatalogEntries.label),
          ),
        firewall:
          sql`CASE WHEN ${firewallEntry} THEN ${connectorCatalogRuntimeColumns.firewall} END`.mapWith(
            nullableDriverValueDecoder(connectorCatalogEntries.firewall),
          ),
      },
    },
    join: connectorCatalogSlugJoin(requestedConnectorSlugs),
    requestedConnectorSlugs,
    firewallConnectorSlugs,
  };
}

export function connectorRuntimeAuthSelectionFromRows(
  rows: readonly {
    readonly current: { readonly schemaVersion: number; readonly hash: string };
    readonly entry: {
      readonly slug: string;
      readonly authMethods: Parameters<
        typeof materializeConnectorCatalogCompatibilityRow
      >[0]["authMethods"];
      readonly mcp: Parameters<
        typeof materializeConnectorCatalogCompatibilityRow
      >[0]["mcp"];
      readonly label: string | null;
      readonly firewall:
        typeof connectorCatalogEntries.$inferSelect.firewall | null;
    } | null;
  }[],
  requestedConnectorSlugs: readonly string[],
  firewallConnectorSlugs: readonly ConnectorSlug[],
): ConnectorRuntimeAuthSelection {
  const source = connectorCatalogSlugSourceFromRows(
    rows.map(({ current, entry }) => {
      if (entry === null) {
        return { current, entry: null };
      }
      const { label, firewall, ...compatibility } = entry;
      return {
        current,
        entry: {
          ...materializeConnectorCatalogCompatibilityRow(compatibility),
          label,
          firewall,
        },
      };
    }),
    requestedConnectorSlugs,
  );
  const lookup = materializeConnectorRuntimeAuthLookup(source);
  const firewallCatalog =
    createAcceptedConnectorServerFirewallCatalogFromConnectors({
      connectors: source.connectors.flatMap(
        ({ slug, mcp, label, firewall }) => {
          return label === null || firewall === null
            ? []
            : [
                {
                  slug,
                  label,
                  firewall,
                  ...(mcp === undefined ? {} : { mcp }),
                },
              ];
        },
      ),
      runtimeMethodsForSlug: (connectorSlug) => {
        return [
          ...(lookup.connectors.get(connectorSlug)?.methods.values() ?? []),
        ].map((method) => {
          return method.method;
        });
      },
    });
  return {
    ...lookup,
    serverFirewalls: selectConnectorServerFirewalls({
      catalog: firewallCatalog,
      connectorSlugs: firewallConnectorSlugs,
    }),
  };
}

export async function loadConnectorRuntimeAuthSelection(
  db: ReadonlyDb,
  args: {
    readonly connectorSlugs: readonly string[];
    readonly firewallConnectorSlugs?: readonly ConnectorSlug[];
  },
): Promise<ConnectorRuntimeAuthSelection> {
  const plan = connectorRuntimeAuthSelectionReadPlan(args);
  const rows = await db
    .select(plan.columns)
    .from(connectorCatalog)
    .leftJoin(connectorCatalogEntries, plan.join)
    .where(connectorCatalogCurrentWhere());
  return connectorRuntimeAuthSelectionFromRows(
    rows,
    plan.requestedConnectorSlugs,
    plan.firewallConnectorSlugs,
  );
}

export const readConnectorRuntimeAuthSelection$ = command(
  async (
    { get },
    args: {
      readonly connectorSlugs: readonly string[];
      readonly firewallConnectorSlugs?: readonly ConnectorSlug[];
    },
    signal: AbortSignal,
  ): Promise<ConnectorRuntimeAuthSelection> => {
    const plan = connectorRuntimeAuthSelectionReadPlan(args);
    const rows = await get(db$)
      .select(plan.columns)
      .from(connectorCatalog)
      .leftJoin(connectorCatalogEntries, plan.join)
      .where(connectorCatalogCurrentWhere());
    signal.throwIfAborted();
    return connectorRuntimeAuthSelectionFromRows(
      rows,
      plan.requestedConnectorSlugs,
      plan.firewallConnectorSlugs,
    );
  },
);

export function createConnectorRuntimeAuthSelection(args: {
  readonly connectorSlugs: readonly string[];
  readonly firewallConnectorSlugs?: readonly ConnectorSlug[];
}) {
  return computed(async (get) => {
    const plan = connectorRuntimeAuthSelectionReadPlan(args);
    const rows = await get(db$)
      .select(plan.columns)
      .from(connectorCatalog)
      .leftJoin(connectorCatalogEntries, plan.join)
      .where(connectorCatalogCurrentWhere());
    return connectorRuntimeAuthSelectionFromRows(
      rows,
      plan.requestedConnectorSlugs,
      plan.firewallConnectorSlugs,
    );
  });
}

/**
 * Runtime connectors for the named slugs, captured with the pointer in one
 * statement. Missing entries are omitted, as they are absent from a
 * whole-catalog snapshot; a missing pointer fails like a whole-catalog read.
 * Metadata-only slugs contribute firewall metadata and never grant execution.
 */
export async function loadConnectorRuntimeSlugSelection(
  db: ReadonlyDb,
  args: {
    readonly connectorSlugs: readonly ConnectorSlug[];
    readonly metadataConnectorSlugs?: readonly ConnectorSlug[];
  },
): Promise<ConnectorRuntimeSelection> {
  const metadataConnectorSlugs = args.metadataConnectorSlugs ?? [];
  const rows = (
    await db
      .select({
        current: {
          schemaVersion: connectorCatalog.schemaVersion,
          hash: connectorCatalog.hash,
        },
        entry: {
          slug: connectorCatalogRuntimeColumns.slug,
          label: connectorCatalogRuntimeColumns.label,
          description: connectorCatalogRuntimeColumns.description,
          category: connectorCatalogRuntimeColumns.category,
          icon: connectorCatalogRuntimeColumns.icon,
          tags: connectorCatalogRuntimeColumns.tags,
          generation: connectorCatalogRuntimeColumns.generation,
          authMethods: connectorCatalogRuntimeColumns.authMethods,
          mcp: connectorCatalogRuntimeColumns.mcp,
          skill: connectorCatalogRuntimeColumns.skill,
          firewall: connectorCatalogRuntimeColumns.firewall,
        },
      })
      .from(connectorCatalog)
      .leftJoin(
        connectorCatalogEntries,
        connectorCatalogSlugJoin([
          ...args.connectorSlugs,
          ...metadataConnectorSlugs,
        ]),
      )
      .where(connectorCatalogCurrentWhere())
  ).map(({ current, entry }) => {
    return {
      current,
      entry:
        entry === null ? null : materializeConnectorCatalogRuntimeRow(entry),
    };
  });
  return {
    ...connectorCatalogSlugRuntimeFromRows(rows, {
      runtimeConnectorSlugs: args.connectorSlugs,
      metadataConnectorSlugs,
    }),
    catalogIdentity: connectorCatalogSlugIdentityFromRows(rows),
  };
}
