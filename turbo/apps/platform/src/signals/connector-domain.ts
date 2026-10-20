import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type { PublicConnectorCatalogPermissionDetail } from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  PublicConnectorCatalogConnectReaderItem,
  PublicConnectorCatalogStatusReaderItem,
} from "@okouai/api-contracts/contracts/connector-catalog-readers";
import type { UserPermissionGrantResponse } from "@okouai/api-contracts/contracts/user-permission-grants";

export type PlatformConnectorCatalogStatusItem =
  PublicConnectorCatalogStatusReaderItem;
/** What a connect surface lists: enough to draw a card and connect from it. */
export type PlatformConnectorCatalogConnectItem =
  PublicConnectorCatalogConnectReaderItem;
export type PlatformConnectorPermissionMetadata =
  PublicConnectorCatalogPermissionDetail;
export type PlatformUserPermissionGrant = UserPermissionGrantResponse;
export type PlatformConnectorAccountMutationIntent = Extract<
  ConnectorAccountMutationIntent,
  { readonly intent: "add" | "reconnect" }
>;
