import type { BuiltinConnectorSearchItem } from "@okouai/api-contracts/contracts/connectors";
import type { BuiltinConnectorBrief } from "@okouai/api-contracts/contracts/connector-overview";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogConnectListResponse,
  PublicConnectorCatalogListResponse,
  PublicConnectorCatalogDiscoveryResponse,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
  PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";

import type { ReadonlyDb } from "../external/db";
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
  publicConnectorCatalogStatusFromSource,
  searchExternalConnectorCatalog,
} from "./connector-catalog-external-reader.service";
import { loadConnectorCatalogSlugSource } from "./connector-catalog-slug-source.service";

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

interface ConnectorCatalogConnectorReadArgs extends ConnectorCatalogReadArgs {
  readonly connectorSlug: ConnectorSlug;
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

/**
 * Label and icon for connectors a response already names, read from the
 * per-connector projection instead of the whole catalog.
 */
export async function listConnectedConnectorBriefs(
  args: ConnectorCatalogReadArgs & {
    readonly connectorSlugs: readonly ConnectorSlug[];
  },
): Promise<readonly BuiltinConnectorBrief[]> {
  return connectorBriefsFromSource({
    catalog: await loadConnectorCatalogSlugSource(args.db, args.connectorSlugs),
    featureStates: args.featureStates,
  });
}

/**
 * Connect items for a connect surface. A named set reads only those connectors
 * from the per-connector projection; the one-click list scans the catalog.
 */
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
    args.filter.kind === "slugs"
      ? await loadConnectorCatalogSlugSource(
          args.db,
          args.filter.connectorSlugs,
        )
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

export async function getPublicConnectorCatalogStatus(
  args: ConnectorCatalogConnectorReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
  },
): Promise<PublicConnectorCatalogStatusItem | null> {
  return publicConnectorCatalogStatusFromSource({
    ...args,
    catalog: await loadConnectorCatalogSlugSource(args.db, [
      args.connectorSlug,
    ]),
  });
}

export async function getPublicConnectorCatalogPermissionDetail(
  args: ConnectorCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  return publicConnectorCatalogPermissionDetailFromSource({
    ...args,
    catalog: await loadConnectorCatalogSlugSource(args.db, [
      args.connectorSlug,
    ]),
  });
}
