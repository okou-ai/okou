import type { BuiltinConnectorSearchItem } from "@okouai/api-contracts/contracts/connectors";
import type { BuiltinConnectorBrief } from "@okouai/api-contracts/contracts/connector-overview";
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
  discoverExternalPublicConnectorCatalogStatus,
  ExternalConnectorCatalogUnavailableError,
  getExternalPublicConnectorCatalogStatus,
  getExternalPublicConnectorCatalogPermissionDetail,
  listExternalConnectorCatalogConnectItems,
  listExternalPublicConnectorCatalog,
  listExternalPublicConnectorCatalogStatus,
  listExternalConnectedConnectorBriefs,
  searchExternalConnectorCatalog,
} from "./connector-catalog-external-reader.service";

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
  readonly connectorSlug: string;
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

export async function listConnectedConnectorBriefs(
  args: ConnectorCatalogReadArgs & {
    readonly connectorSlugs: readonly string[];
  },
): Promise<readonly BuiltinConnectorBrief[]> {
  return await listExternalConnectedConnectorBriefs(args);
}

export async function listConnectorCatalogConnectItems(
  args: ConnectorCatalogReadArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
    readonly filter:
      | { readonly kind: "slugs"; readonly connectorSlugs: readonly string[] }
      | { readonly kind: "one-click" };
  },
): Promise<PublicConnectorCatalogConnectListResponse> {
  return await listExternalConnectorCatalogConnectItems(args);
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
  return await getExternalPublicConnectorCatalogStatus(args);
}

export async function getPublicConnectorCatalogPermissionDetail(
  args: ConnectorCatalogConnectorReadArgs,
): Promise<PublicConnectorCatalogPermissionDetail | null> {
  return await getExternalPublicConnectorCatalogPermissionDetail(args);
}
