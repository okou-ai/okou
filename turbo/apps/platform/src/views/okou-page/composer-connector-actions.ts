import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { useLoadable, useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ComposerConnectorSignals } from "../../signals/okou-page/connectors.ts";
import {
  builtinConnectOperation$,
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
  const savingAccount = useGet(signals.accounts.saving$);
  const commitAccountSelection = useSet(signals.accounts.commitSelection$);
  const [browserAuth, connectBrowserAuth] = useLoadableSet(
    connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  );
  const [noAuth, connectNoAuth] = useLoadableSet(
    connectBuiltinConnectorNoAuthAndSettle$,
  );
  const connectOperation = useLoadable(builtinConnectOperation$);
  const pollingAuthCodeSlug = useGet(builtinPollingOAuthAuthCodeSlug$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const runConnectSuccess = useSet(runBuiltinConnectorConnectSuccess$);
  return {
    savingAuthorization: authorization.state === "loading",
    setAuthorization,
    savingAccount,
    commitAccountSelection,
    connecting: browserAuth.state === "loading" || noAuth.state === "loading",
    isConnectorConnecting: (connectorSlug: ConnectorSlug) => {
      return (
        connectOperation.state === "loading" ||
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
