import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type {
  PublicConnectorCatalogConnectItem,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { UserPermissionGrantResponse } from "@okouai/api-contracts/contracts/user-permission-grants";

export type PlatformBuiltinConnector = BuiltinConnectorResponse;
export type PlatformConnectorCatalogStatusItem =
  PublicConnectorCatalogStatusItem;
/** What a connect surface lists: enough to draw a card and connect from it. */
export type PlatformConnectorCatalogConnectItem =
  PublicConnectorCatalogConnectItem;
export type PlatformConnectorPermissionMetadata =
  PublicConnectorCatalogPermissionDetail;
export type PlatformUserPermissionGrant = UserPermissionGrantResponse;
export type PlatformConnectorAccountMutationIntent = Extract<
  ConnectorAccountMutationIntent,
  { readonly intent: "add" | "reconnect" }
>;
