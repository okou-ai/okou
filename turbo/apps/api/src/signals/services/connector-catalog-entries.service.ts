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
import { singleton } from "../../lib/singleton";
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

const rawEntries = singleton(() => {
  return new Map<string, ImmutableConnectorCatalogEntry>();
});
const RAW_ENTRY_CACHE_LIMIT = 512;

function rememberEntry(
  hash: string,
  slug: string,
  payload: ImmutableConnectorCatalogEntry,
) {
  const cache = rawEntries();
  const key = `${hash}\0${slug}`;
  const entry = cache.get(key) ?? payload;
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > RAW_ENTRY_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  return entry;
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
      selected.push(rememberEntry(captured.hash, slug, entry));
    }
    return { capturedCatalog: captured, entries: selected };
  });
}

/** No legacy identity, validator, projection, R2 or full-snapshot fallback. */
export function immutableConnectorRuntimeSelection(
  input: SelectionInput,
): Computed<Promise<ImmutableConnectorRuntimeSelection>> {
  const source$ = capturedEntries(input);
  return computed(async (get) => {
    const { capturedCatalog, entries } = await get(source$);
    // Only code/configuration capability filtering is derived here. Feature,
    // account and grant filtering remain with their existing request owners.
    // No derived cache crosses a capability digest or request boundary.
    const capability = connectorCatalogExecutableCapabilityState();
    const filtered = evaluateConnectorCatalogCompatibility({
      artifact: { ...capturedCatalog.header, connectors: [...entries] },
      capability,
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
          input.requestedConnectorSlugs,
        ),
        metadataConnectorSlugs: uniqueSortedConnectorSlugs(
          input.metadataConnectorSlugs ?? [],
        ),
      }),
      capturedCatalog,
      catalogIdentity: {
        schemaVersion: capturedCatalog.schemaVersion,
        hash: capturedCatalog.hash,
        capabilityDigest: capability.digest,
      },
    };
  });
}
