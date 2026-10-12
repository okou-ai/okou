import type { BuiltinConnectorSearchItem } from "@okouai/api-contracts/contracts/connectors";
import type { BuiltinConnectorBrief } from "@okouai/api-contracts/contracts/connector-overview";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogConnectListResponse,
  PublicConnectorCatalogListResponse,
  PublicConnectorCatalogDiscoveryResponse,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import {
  connectorCatalogDisplayColumns,
  connectorCatalogRuntimeColumns,
  materializeConnectorCatalogDisplayRow,
} from "./connector-catalog-columns";
import { computed, type Computed } from "ccstate";
import { db$, type ReadonlyDb } from "../external/db";
import type { ConnectorFeatureStates } from "./connector-catalog-feature-states";
import type { ConnectorCatalogConnection } from "./connector-catalog-connection";
import {
  connectorBriefsFromSource,
  connectorCatalogConnectItemsFromSource,
  discoverExternalPublicConnectorCatalogStatus,
  ExternalConnectorCatalogUnavailableError,
  listExternalPublicConnectorCatalog,
  listExternalPublicConnectorCatalogStatus,
  loadCompleteConnectorCatalogSource,
  publicConnectorCatalogPermissionDetailFromSource,
  searchExternalConnectorCatalog,
} from "./connector-catalog-external-reader.service";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
  connectorCatalogSlugSourceFromRows,
} from "./connector-catalog-slug-source.service";

export function isConnectorCatalogUnavailableError(error: unknown): boolean {
  return error instanceof ExternalConnectorCatalogUnavailableError;
}

interface ConnectorCatalogReadArgs {
  readonly db: ReadonlyDb;
  readonly featureStates: ConnectorFeatureStates;
}

interface ConnectorCatalogSearchArgs extends ConnectorCatalogReadArgs {
  readonly keyword: string | undefined;
}

/**
 * Connected briefs and connect items by slug are optional reads, so a slug
 * without an entry is omitted. Required paths reject through their own readers.
 */
async function loadSlugDisplaySource(
  db: ReadonlyDb,
  slugs: readonly ConnectorSlug[],
) {
  const rows = await db
    .select({
      current: {
        schemaVersion: connectorCatalog.schemaVersion,
        hash: connectorCatalog.hash,
      },
      entry: connectorCatalogDisplayColumns,
    })
    .from(connectorCatalog)
    .leftJoin(connectorCatalogEntries, connectorCatalogSlugJoin(slugs))
    .where(connectorCatalogCurrentWhere());
  return connectorCatalogSlugSourceFromRows(
    rows.map((row) => {
      return {
        current: row.current,
        entry:
          row.entry === null
            ? null
            : materializeConnectorCatalogDisplayRow(row.entry),
      };
    }),
    slugs,
  );
}

export async function searchConnectorCatalog(
  args: ConnectorCatalogSearchArgs,
): Promise<BuiltinConnectorSearchItem[]> {
  return await searchExternalConnectorCatalog(args);
}

export async function listPublicConnectorCatalog(
  args: ConnectorCatalogReadArgs,
): Promise<PublicConnectorCatalogListResponse> {
  return await listExternalPublicConnectorCatalog(args);
}

export async function listPublicConnectorCatalogStatus(
  args: ConnectorCatalogReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
  },
): Promise<PublicConnectorCatalogStatusResponse> {
  const read = await listExternalPublicConnectorCatalogStatus({
    ...args,
    referenceConnectorSlugs: [],
  });
  return read.status;
}

export function connectorBriefsFromRows(args: {
  readonly rows: readonly {
    readonly current: {
      readonly schemaVersion: number;
      readonly hash: string;
    };
    readonly entry:
      Parameters<typeof materializeConnectorCatalogDisplayRow>[0] | null;
  }[];
  readonly featureStates: ConnectorFeatureStates;
  readonly connectorSlugs: readonly ConnectorSlug[];
}): readonly BuiltinConnectorBrief[] {
  return connectorBriefsFromSource({
    catalog: connectorCatalogSlugSourceFromRows(
      args.rows.map((row) => {
        return {
          current: row.current,
          entry:
            row.entry === null
              ? null
              : materializeConnectorCatalogDisplayRow(row.entry),
        };
      }),
      args.connectorSlugs,
    ),
    featureStates: args.featureStates,
  });
}

export async function listConnectorCatalogConnectItems(
  args: ConnectorCatalogReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
    readonly filter:
      | {
          readonly kind: "slugs";
          readonly connectorSlugs: readonly ConnectorSlug[];
        }
      | { readonly kind: "one-click" };
  },
): Promise<PublicConnectorCatalogConnectListResponse> {
  const catalog =
    args.filter.kind === "slugs" && args.filter.connectorSlugs.length === 0
      ? { connectors: [], filteredMethodKeys: new Set<string>() }
      : args.filter.kind === "slugs"
        ? await loadSlugDisplaySource(args.db, args.filter.connectorSlugs)
        : await loadCompleteConnectorCatalogSource(args.db);
  return connectorCatalogConnectItemsFromSource({
    catalog,
    featureStates: args.featureStates,
    connections: args.connections,
    oneClickOnly: args.filter.kind === "one-click",
  });
}

export async function discoverPublicConnectorCatalogStatus(
  args: ConnectorCatalogReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
    readonly keyword: string | undefined;
    readonly category: string | undefined;
  },
): Promise<PublicConnectorCatalogDiscoveryResponse> {
  const read = await discoverExternalPublicConnectorCatalogStatus({
    ...args,
    referenceConnectorSlugs: [],
  });
  return read.status;
}

export function publicConnectorCatalogPermissionDetail(
  scope$: Computed<
    Promise<{
      readonly connectorSlug: ConnectorSlug;
      readonly featureStates: ConnectorFeatureStates;
    }>
  >,
) {
  return computed(
    async (get): Promise<PublicConnectorCatalogPermissionDetail | null> => {
      const args = await get(scope$);
      const rows = await get(db$)
        .select({
          current: {
            schemaVersion: connectorCatalog.schemaVersion,
            hash: connectorCatalog.hash,
          },
          entry: {
            slug: connectorCatalogRuntimeColumns.slug,
            authMethods: connectorCatalogRuntimeColumns.authMethods,
            mcp: connectorCatalogRuntimeColumns.mcp,
            label: connectorCatalogRuntimeColumns.label,
            icon: connectorCatalogRuntimeColumns.icon,
            firewall: connectorCatalogRuntimeColumns.firewall,
          },
        })
        .from(connectorCatalog)
        .leftJoin(
          connectorCatalogEntries,
          connectorCatalogSlugJoin([args.connectorSlug]),
        )
        .where(connectorCatalogCurrentWhere());
      const catalog = connectorCatalogSlugSourceFromRows(
        rows.map((row) => {
          if (row.entry === null) {
            return { current: row.current, entry: null };
          }
          const { mcp, ...fields } = row.entry;
          return {
            current: row.current,
            entry: { ...fields, ...(mcp === null ? {} : { mcp }) },
          };
        }),
        [args.connectorSlug],
      );
      return publicConnectorCatalogPermissionDetailFromSource({
        ...args,
        catalog,
      });
    },
  );
}
