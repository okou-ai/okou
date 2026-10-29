import type { MailProvider } from "@okouai/api-contracts/contracts/mail";
import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";

import { connectorCatalogItemBySlug } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail,
} from "../../signals/okou-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";

// Read the selected provider entry without loading the full connector catalog.
const gmailCatalogItem$ = connectorCatalogItemBySlug("gmail");
const outlookCatalogItem$ = connectorCatalogItemBySlug("outlook-mail");

export function useMailReconnect(
  provider: MailProvider,
  connectionId: string | undefined,
  onSuccess: () => void | Promise<void>,
) {
  const connector =
    useLastResolved(
      provider === "gmail" ? gmailCatalogItem$ : outlookCatalogItem$,
    ) ?? undefined;
  const [connection, connect] = useLoadableSet(
    connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  );
  const signal = useGet(pageSignal$);
  const authMethod = connector
    ? getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail(connector)
    : null;
  const reconnecting = connection.state === "loading";

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
            connectorSlug: provider === "gmail" ? "gmail" : "outlook-mail",
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
