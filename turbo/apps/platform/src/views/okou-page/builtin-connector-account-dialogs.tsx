import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  builtinAccountConnectDialog$,
  builtinAccountManager$,
  closeBuiltinAccountConnectDialog$,
  closeBuiltinAccountManager$,
  openBuiltinAccountConnectDialog$,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import {
  builtinConnectorScopeReviewCatalogItem$,
  builtinConnectorScopeReviewSelection$,
  setBuiltinConnectorScopeReviewSelection$,
} from "../../signals/okou-page/settings/connectors.ts";
import {
  connectBuiltinConnectorNoAuthAndContinue$,
  connectBuiltinConnectorOAuthAuthCodeAndContinue$,
} from "../../signals/okou-page/settings/connector-connect-continuation.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { ConnectorAccountManagerDialog } from "./components/settings/connector-account-manager-dialog.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ScopeReviewModal } from "./components/settings/scope-review-modal.tsx";
import {
  launchConnectorConnect,
  type ConnectorConnectHandlers,
} from "./components/settings/launch-connector-connect.ts";

export function useBuiltinConnectorConnectHandlers() {
  const openAccountConnect = useSet(openBuiltinAccountConnectDialog$);
  const [browserAuth, connect] = useLoadableSet(
    connectBuiltinConnectorOAuthAuthCodeAndContinue$,
  );
  const [noAuth, connectNoAuth] = useLoadableSet(
    connectBuiltinConnectorNoAuthAndContinue$,
  );
  const signal = useGet(pageSignal$);

  const accountConnectHandlers = (
    connector: PlatformConnectorCatalogStatusItem,
  ): ConnectorConnectHandlers => {
    return {
      openModal: () => {
        openAccountConnect(connector, { kind: "add" });
      },
      connectBrowserAuth: async (authMethod) => {
        await connect(
          {
            connectorSlug: connector.slug,
            method: authMethod,
            options: {
              account: { intent: "add" },
              connectorLabel: connector.label,
              connectorIcon: connector.icon,
            },
            origin: { kind: "account", mode: { kind: "add" } },
          },
          signal,
        );
      },
      connectNoAuth: async (authMethod) => {
        await connectNoAuth(
          {
            connectorSlug: connector.slug,
            authMethod,
            options: {
              account: { intent: "add" },
              connectorLabel: connector.label,
            },
            origin: { kind: "account", mode: { kind: "add" } },
          },
          signal,
        );
      },
    };
  };

  return {
    accountConnectHandlers,
    connecting: browserAuth.state === "loading" || noAuth.state === "loading",
  };
}

function BuiltinAccountConnectDialog() {
  const accountConnect = useGet(builtinAccountConnectDialog$);
  const closeAccountConnect = useSet(closeBuiltinAccountConnectDialog$);
  return accountConnect ? (
    <ConnectModal
      item={accountConnect.connector}
      accountMode={accountConnect.mode}
      accountOptions={{
        account:
          accountConnect.mode.kind === "add"
            ? { intent: "add" }
            : {
                intent: "reconnect",
                connectionId: accountConnect.mode.connectionId,
              },
      }}
      onClose={() => {
        closeAccountConnect();
      }}
      origin={{ kind: "account", mode: accountConnect.mode }}
    />
  ) : null;
}

function BuiltinAccountManagerDialog({
  finalFocus,
}: {
  readonly finalFocus?: () => HTMLElement | boolean;
}) {
  const managedAccountConnector = useGet(builtinAccountManager$);
  return managedAccountConnector ? (
    <BuiltinAccountManagerBody
      connector={managedAccountConnector}
      finalFocus={finalFocus}
    />
  ) : null;
}

function BuiltinAccountManagerBody({
  connector: managedAccountConnector,
  finalFocus,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly finalFocus?: () => HTMLElement | boolean;
}) {
  const closeAccountManager = useSet(closeBuiltinAccountManager$);
  const openAccountConnect = useSet(openBuiltinAccountConnectDialog$);
  const setScopeReviewSelection = useSet(
    setBuiltinConnectorScopeReviewSelection$,
  );
  const { accountConnectHandlers } = useBuiltinConnectorConnectHandlers();
  return (
    <ConnectorAccountManagerDialog
      finalFocus={finalFocus}
      target={{
        kind: "builtin",
        connectorSlug: managedAccountConnector.slug,
      }}
      connectorLabel={managedAccountConnector.label}
      icon={<ConnectorIcon icon={managedAccountConnector.icon} size={20} />}
      onClose={() => {
        closeAccountManager();
      }}
      onAdd={() => {
        closeAccountManager();
        launchConnectorConnect({
          connector: managedAccountConnector,
          ...accountConnectHandlers(managedAccountConnector),
        });
      }}
      onReconnect={(account) => {
        openAccountConnect(managedAccountConnector, {
          kind: "reconnect",
          connectionId: account.id,
          authMethod: account.authMethod,
        });
      }}
      onReviewScopes={(account) => {
        closeAccountManager();
        setScopeReviewSelection({
          connectorSlug: managedAccountConnector.slug,
          connectionId: account.id,
          authMethod: account.authMethod,
        });
      }}
    />
  );
}

function BuiltinScopeReviewDialog() {
  const selection = useGet(builtinConnectorScopeReviewSelection$);
  return selection ? <BuiltinScopeReviewBody /> : null;
}

function BuiltinScopeReviewBody() {
  const scopeReviewSelection = useGet(builtinConnectorScopeReviewSelection$);
  const setScopeReviewSelection = useSet(
    setBuiltinConnectorScopeReviewSelection$,
  );
  const openAccountConnect = useSet(openBuiltinAccountConnectDialog$);
  const catalog = useLastLoadable(builtinConnectorScopeReviewCatalogItem$);
  const connector = catalog.state === "hasData" ? catalog.data : null;
  return scopeReviewSelection ? (
    <ScopeReviewModal
      selection={scopeReviewSelection}
      onClose={() => {
        return setScopeReviewSelection(null);
      }}
      onReconnect={(selection) => {
        if (connector?.slug === selection.connectorSlug) {
          setScopeReviewSelection(null);
          openAccountConnect(connector, {
            kind: "reconnect",
            connectionId: selection.connectionId,
            authMethod: selection.authMethod,
          });
        }
      }}
    />
  ) : null;
}

export function BuiltinConnectorAccountDialogs({
  finalFocus,
}: {
  readonly finalFocus?: () => HTMLElement | boolean;
}) {
  return (
    <>
      <BuiltinAccountConnectDialog />
      <BuiltinAccountManagerDialog finalFocus={finalFocus} />
      <BuiltinScopeReviewDialog />
    </>
  );
}
