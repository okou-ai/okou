import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ComposerConnectorSignals } from "../../signals/okou-page/connectors.ts";
import {
  builtinConnectFlowSlug$,
  builtinPollingOAuthAuthCodeSlug$,
  builtinPollingOAuthDeviceAuthSlug$,
  connectBuiltinConnectorNoAuthAndSettle$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  runBuiltinConnectorConnectSuccess$,
} from "../../signals/okou-page/settings/connectors.ts";

export function useComposerConnectorActions(signals: ComposerConnectorSignals) {
  const [authorization, setAuthorization] = useLoadableSet(
    signals.setConnectorAuthorization$,
  );
  const [account, selectAccount] = useLoadableSet(
    signals.accounts.selectAccount$,
  );
  const [defaultAccount, useDefaultAccount] = useLoadableSet(
    signals.accounts.useDefault$,
  );
  const [browserAuth, connectBrowserAuth] = useLoadableSet(
    connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  );
  const [noAuth, connectNoAuth] = useLoadableSet(
    connectBuiltinConnectorNoAuthAndSettle$,
  );
  const connectFlowSlug = useGet(builtinConnectFlowSlug$);
  const pollingAuthCodeSlug = useGet(builtinPollingOAuthAuthCodeSlug$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const runConnectSuccess = useSet(runBuiltinConnectorConnectSuccess$);
  return {
    savingAuthorization: authorization.state === "loading",
    setAuthorization,
    savingAccount:
      account.state === "loading" || defaultAccount.state === "loading",
    selectAccount,
    useDefaultAccount,
    connecting: browserAuth.state === "loading" || noAuth.state === "loading",
    isConnectorConnecting: (connectorSlug: ConnectorSlug) => {
      return (
        connectFlowSlug === connectorSlug ||
        pollingAuthCodeSlug === connectorSlug ||
        pollingDeviceAuthSlug === connectorSlug
      );
    },
    connectBrowserAuth,
    connectNoAuth,
    runConnectSuccess,
  };
}

export type ComposerConnectorActions = ReturnType<
  typeof useComposerConnectorActions
>;
