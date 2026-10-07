import { computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import type { ImmutableConnectorCatalogEntry } from "@okouai/db/jsonb-contracts/immutable-connector-catalog";
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
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import { catalogIdentityFromCapture } from "./connector-catalog-view";

export interface ImmutableConnectorCatalogCapture {
  readonly schemaVersion: number;
  readonly hash: string;
}

export interface ImmutableConnectorRuntimeSelection extends ConnectorRuntimeLookup {
  readonly capturedCatalog: ImmutableConnectorCatalogCapture;
  readonly catalogIdentity: {
    readonly schemaVersion: number;
    readonly hash: string;
    readonly capabilityDigest: string;
  };
}

/**
 * A requested slug with no entry at the captured hash is left absent, exactly
 * as if the user had never authorized it: a delisted connector cannot be
 * disconnected, so no reader may fail on it. Metadata-only dependencies never
 * grant execution.
 */
interface SelectionInput {
  readonly requestedConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs?: readonly ConnectorSlug[];
  readonly capturedCatalog?: ImmutableConnectorCatalogCapture;
}

interface CapturedEntries {
  readonly input: SelectionInput;
  readonly capturedCatalog: ImmutableConnectorCatalogCapture;
  readonly entries: readonly ImmutableConnectorCatalogEntry[];
}

/** Capture the pointer and requested union in one database statement. */
function capturedEntries(
  input$: Computed<Promise<SelectionInput>>,
): Computed<Promise<CapturedEntries>>;
function capturedEntries(
  input$: Computed<Promise<SelectionInput | null>>,
): Computed<Promise<CapturedEntries | null>>;
function capturedEntries(
  input$: Computed<Promise<SelectionInput | null>>,
): Computed<Promise<CapturedEntries | null>> {
  return computed(async (get) => {
    const input = await get(input$);
    if (!input) {
      return null;
    }
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
    return {
      input,
      capturedCatalog: captured,
      entries: slugs.flatMap((slug) => {
        const entry = entries.get(slug);
        return entry === undefined ? [] : [entry];
      }),
    };
  });
}

export function immutableConnectorRuntimeSelection(
  input: SelectionInput,
): Computed<Promise<ImmutableConnectorRuntimeSelection>> {
  const input$ = computed(() => {
    return Promise.resolve(input);
  });
  const source$ = capturedEntries(input$);
  return computed(async (get) => {
    return materializeImmutableSelection(input, await get(source$));
  });
}

/**
 * An agent can keep a connector whose entry has left the catalog; the Run
 * launches without it instead of failing.
 */
interface CatalogRequest {
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
}

export function createConnectorRuntimeSelection(
  requested$: Computed<Promise<CatalogRequest | null>>,
): Computed<Promise<ConnectorRuntimeSelection | null>> {
  const input$ = computed(async (get) => {
    const requested = await get(requested$);
    return requested
      ? {
          requestedConnectorSlugs: requested.runtimeConnectorSlugs,
          metadataConnectorSlugs: requested.metadataConnectorSlugs,
        }
      : null;
  });
  const source$ = capturedEntries(input$);
  return computed(async (get) => {
    const source = await get(source$);
    if (!source) {
      return null;
    }
    const selection = materializeImmutableSelection(source.input, source);
    return {
      ...selection,
      catalogIdentity: catalogIdentityFromCapture(
        selection.capturedCatalog,
        selection.catalogIdentity.capabilityDigest,
      ),
    };
  });
}

function materializeImmutableSelection(
  input: SelectionInput,
  { capturedCatalog, entries }: CapturedEntries,
): ImmutableConnectorRuntimeSelection {
  const capability = connectorCatalogExecutableCapabilityState();
  const filtered = evaluateConnectorCatalogCompatibility({
    artifact: { connectors: [...entries] },
    capability,
  });
  return {
    ...materializeConnectorRuntimeLookup({
      connectors: entries,
      filteredMethodKeys: new Set(
        filtered.map((method) => {
          return `${method.connectorSlug}\0${method.authMethodId}`;
        }),
      ),
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
}
