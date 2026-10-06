import { computed, type Computed } from "ccstate";
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
import { db$ } from "../external/db";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
} from "./connector-catalog-compatibility.service";
import {
  materializeConnectorRuntimeLookup,
  uniqueSortedConnectorSlugs,
  type ConnectorRuntimeLookup,
} from "./connector-catalog-runtime.service";

export interface ImmutableConnectorCatalogCapture {
  readonly schemaVersion: number;
  readonly hash: string;
  readonly header: ImmutableConnectorCatalogHeader;
  readonly entrySlugs: readonly string[];
}

export interface ImmutableConnectorRuntimeSelection extends ConnectorRuntimeLookup {
  readonly capturedCatalog: ImmutableConnectorCatalogCapture;
  readonly catalogIdentity: {
    readonly schemaVersion: number;
    readonly hash: string;
    readonly capabilityDigest: string;
  };
}

interface SelectionInput {
  readonly requestedConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs?: readonly ConnectorSlug[];
  readonly capturedCatalog?: ImmutableConnectorCatalogCapture;
}

/** One statement captures current and the requested union, including empty/unknown sets. */
function capturedEntries(input: SelectionInput): Computed<
  Promise<{
    readonly capturedCatalog: ImmutableConnectorCatalogCapture;
    readonly entries: readonly ImmutableConnectorCatalogEntry[];
  }>
> {
  return computed(async (get) => {
    const slugs = uniqueSortedConnectorSlugs([
      ...input.requestedConnectorSlugs,
      ...(input.metadataConnectorSlugs ?? []),
    ]);
    const db = get(db$);
    let captured = input.capturedCatalog;
    const rows =
      captured === undefined
        ? await db
            .select({
              current: {
                schemaVersion: connectorCatalog.schemaVersion,
                hash: connectorCatalog.hash,
                header: connectorCatalog.catalogHeader,
                entrySlugs: connectorCatalog.entrySlugs,
              },
              entry: {
                slug: connectorCatalogEntries.slug,
                payload: connectorCatalogEntries.payload,
              },
            })
            .from(connectorCatalog)
            .leftJoin(
              connectorCatalogEntries,
              and(
                eq(connectorCatalogEntries.hash, connectorCatalog.hash),
                inArray(connectorCatalogEntries.slug, [...slugs]),
              ),
            )
            .where(
              eq(
                connectorCatalog.schemaVersion,
                SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
              ),
            )
        : await db
            .select({
              slug: connectorCatalogEntries.slug,
              payload: connectorCatalogEntries.payload,
            })
            .from(connectorCatalogEntries)
            .where(
              and(
                eq(connectorCatalogEntries.hash, captured.hash),
                inArray(connectorCatalogEntries.slug, [...slugs]),
              ),
            );
    const entries = new Map<string, ImmutableConnectorCatalogEntry>();
    for (const row of rows) {
      if ("current" in row) {
        captured = row.current;
        if (row.entry !== null) {
          entries.set(row.entry.slug, row.entry.payload);
        }
      } else {
        entries.set(row.slug, row.payload);
      }
    }
    if (captured === undefined) {
      throw new Error("Immutable connector catalog current is missing");
    }
    if (captured.schemaVersion !== SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION) {
      throw new Error("Immutable connector catalog schema is unsupported");
    }
    const manifest = new Set(captured.entrySlugs);
    const selected: ImmutableConnectorCatalogEntry[] = [];
    for (const slug of slugs) {
      if (!manifest.has(slug)) {
        continue;
      }
      const entry = entries.get(slug);
      if (entry === undefined) {
        throw new Error(
          "Immutable connector catalog manifest entry is missing",
        );
      }
      selected.push(entry);
    }
    return { capturedCatalog: captured, entries: selected };
  });
}

/** Plain captured facts shared by request readers and transaction owners. */
export function materializeImmutableConnectorRuntimeSelection(args: {
  readonly capturedCatalog: ImmutableConnectorCatalogCapture;
  readonly entries: readonly ImmutableConnectorCatalogEntry[];
  readonly requestedConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
  readonly capability: ReturnType<
    typeof connectorCatalogExecutableCapabilityState
  >;
}): ImmutableConnectorRuntimeSelection {
  const manifest = new Set(args.capturedCatalog.entrySlugs);
  const union = new Set([
    ...args.requestedConnectorSlugs,
    ...args.metadataConnectorSlugs,
  ]);
  const entries = args.entries.filter((entry) => {
    return manifest.has(entry.slug) && union.has(entry.slug);
  });
  const present = new Set(
    entries.map((entry) => {
      return entry.slug;
    }),
  );
  for (const slug of union) {
    if (manifest.has(slug) && !present.has(slug)) {
      throw new Error("Immutable connector catalog manifest entry is missing");
    }
  }
  const filtered = evaluateConnectorCatalogCompatibility({
    artifact: { ...args.capturedCatalog.header, connectors: entries },
    capability: args.capability,
  });
  const filteredMethodKeys = new Set(
    filtered.map((method) => {
      return `${method.connectorSlug}\0${method.authMethodId}`;
    }),
  );
  return {
    ...materializeConnectorRuntimeLookup({
      connectors: entries,
      filteredMethodKeys,
      runtimeConnectorSlugs: uniqueSortedConnectorSlugs(
        args.requestedConnectorSlugs,
      ),
      metadataConnectorSlugs: uniqueSortedConnectorSlugs(
        args.metadataConnectorSlugs,
      ),
    }),
    capturedCatalog: args.capturedCatalog,
    catalogIdentity: {
      schemaVersion: args.capturedCatalog.schemaVersion,
      hash: args.capturedCatalog.hash,
      capabilityDigest: args.capability.digest,
    },
  };
}

/** No legacy identity, validator, projection, R2 or full-snapshot fallback. */
export function immutableConnectorRuntimeSelection(
  input: SelectionInput,
): Computed<Promise<ImmutableConnectorRuntimeSelection>> {
  const source$ = capturedEntries(input);
  return computed(async (get) => {
    const { capturedCatalog, entries } = await get(source$);
    // Feature, account and grant filtering stay with their request owners.
    return materializeImmutableConnectorRuntimeSelection({
      capturedCatalog,
      entries,
      requestedConnectorSlugs: input.requestedConnectorSlugs,
      metadataConnectorSlugs: input.metadataConnectorSlugs ?? [],
      capability: connectorCatalogExecutableCapabilityState(),
    });
  });
}
