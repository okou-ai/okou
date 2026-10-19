import type { BuiltinConnectorBrief } from "@okouai/api-contracts/contracts/connector-overview";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogPermissionDetail } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import {
  connectorCatalogRuntimeColumns,
  materializeConnectorCatalogDisplayRow,
} from "./connector-catalog-columns";
import { computed, type Computed } from "ccstate";
import { db$ } from "../external/db";
import type { ConnectorFeatureStates } from "./connector-catalog-feature-states";
import {
  connectorBriefsFromSource,
  ExternalConnectorCatalogUnavailableError,
  publicConnectorCatalogPermissionDetailFromSource,
} from "./connector-catalog-external-reader.service";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
  connectorCatalogSlugSourceFromRows,
} from "./connector-catalog-slug-source.service";

export function isConnectorCatalogUnavailableError(error: unknown): boolean {
  return error instanceof ExternalConnectorCatalogUnavailableError;
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
