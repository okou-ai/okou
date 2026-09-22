import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";

import { connectorCatalogStatusBySlug$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  builtinConnectFlowSlugs$,
  getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail,
} from "../../signals/okou-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function useGmailReconnect(
  connectionId: string | undefined,
  onSuccess: () => void | Promise<void>,
) {
  const catalogBySlug = useLastResolved(connectorCatalogStatusBySlug$);
  const connectFlowConnectorSlugs = useGet(builtinConnectFlowSlugs$);
  const [connection, connect] = useLoadableSet(
    connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  );
  const signal = useGet(pageSignal$);
  const connector = catalogBySlug?.get("gmail");
  const authMethod = connector
    ? getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail(connector)
    : null;
  const reconnecting =
    connectFlowConnectorSlugs.has("gmail") || connection.state === "loading";

  return {
    connectorIcon: connector?.icon,
    reconnecting,
    reconnectDisabled:
      !connectionId || !connector || !authMethod || reconnecting,
    reconnect() {
      if (!connectionId || !connector || !authMethod || reconnecting) {
        return;
      }
      detach(
        connect(
          {
            connectorSlug: "gmail",
            method: authMethod,
            onSuccess,
            options: {
              authorizeVisibleAgents: true,
              connectorLabel: connector.label,
              connectorIcon: connector.icon,
              account: { intent: "reconnect", connectionId },
            },
          },
          signal,
        ),
        Reason.DomCallback,
      );
    },
  };
}
