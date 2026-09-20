import type { ConnectorAuthMethodId } from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogAuthMethodDetail } from "@okouai/api-contracts/contracts/connector-catalog";

import type { PlatformConnectorCatalogStatusItem } from "../../../../signals/connector-domain.ts";
import { getBuiltinConnectorStatusDirectConnectMethod } from "../../../../signals/okou-page/settings/connectors.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export interface ConnectorConnectHandlers {
  readonly openModal: () => void;
  readonly connectBrowserAuth: (
    authMethod: PublicConnectorCatalogAuthMethodDetail,
  ) => Promise<unknown>;
  readonly connectNoAuth: (
    authMethod: ConnectorAuthMethodId,
  ) => Promise<unknown>;
}

interface LaunchConnectorConnectOptions extends ConnectorConnectHandlers {
  readonly connector: PlatformConnectorCatalogStatusItem;
}

export function launchConnectorConnect({
  connector,
  openModal,
  connectBrowserAuth,
  connectNoAuth,
}: LaunchConnectorConnectOptions): void {
  const directConnectMethod =
    getBuiltinConnectorStatusDirectConnectMethod(connector);
  if (!directConnectMethod) {
    openModal();
    return;
  }
  if (directConnectMethod.kind === "browser-auth") {
    detach(
      connectBrowserAuth(directConnectMethod.authMethod),
      Reason.DomCallback,
    );
    return;
  }

  detach(connectNoAuth(directConnectMethod.authMethod), Reason.DomCallback);
}
