import type {
  ConnectorAccountConnection,
  ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type {
  PublicConnectorCatalogConnectItem,
  PublicConnectorCatalogStatusItem,
  PublicConnectorCatalogPermissionDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { UserPermissionGrantResponse } from "@okouai/api-contracts/contracts/user-permission-grants";

export type PlatformConnectorConnectionStatus =
  "not-connected" | "connected" | "scope-mismatch" | "reconnect-required";
export type PlatformConnectorConnection = Pick<
  ConnectorAccountConnection,
  "id" | "authMethod" | "externalUsername" | "externalEmail" | "reconnectReason"
>;

/** Active UI state derived from canonical accounts, never catalog wire status. */
interface BuiltinConnectorAccountView {
  readonly setupStatus: ConnectorAccountConnection["setupStatus"] | null;
  readonly connected: boolean;
  readonly connection: PlatformConnectorConnection | null;
  readonly connectionStatus: PlatformConnectorConnectionStatus | undefined;
  readonly scopeMismatch: boolean | undefined;
  readonly authMethodSupportsRefresh: boolean | undefined;
  readonly tokenExpiresAt: string | null;
}
export type PlatformConnectorCatalogStatusItem =
  PublicConnectorCatalogStatusItem & BuiltinConnectorAccountView;
export type PlatformConnectorCatalogConnectItem =
  PublicConnectorCatalogConnectItem & BuiltinConnectorAccountView;
export type PlatformConnectorPermissionMetadata =
  PublicConnectorCatalogPermissionDetail;
export type PlatformUserPermissionGrant = UserPermissionGrantResponse;
export type PlatformConnectorAccountMutationIntent = Extract<
  ConnectorAccountMutationIntent,
  { readonly intent: "add" | "reconnect" }
>;
