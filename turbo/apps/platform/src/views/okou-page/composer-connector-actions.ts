import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { useLoadable, useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ComposerConnectorSignals } from "../../signals/okou-page/connectors.ts";
import {
  builtinConnectExecution$,
  builtinConnectOperation$,
  builtinPollingOAuthDeviceAuthSlug$,
  connectBuiltinConnectorNoAuthAndSettle$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  runBuiltinConnectorConnectSuccess$,
} from "../../signals/okou-page/settings/connectors.ts";

export function useComposerConnectorActions(signals: ComposerConnectorSignals) {
  const [authorization, setAuthorization] = useLoadableSet(
    signals.setConnectorAuthorization$,
  );
  const commitAccountSelection = useSet(signals.accounts.commitSelection$);
  const [browserAuth, connectBrowserAuth] = useLoadableSet(
    connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  );
  const [noAuth, connectNoAuth] = useLoadableSet(
    connectBuiltinConnectorNoAuthAndSettle$,
  );
  const connectExecution = useGet(builtinConnectExecution$);
  const connectOperation = useLoadable(builtinConnectOperation$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const runConnectSuccess = useSet(runBuiltinConnectorConnectSuccess$);
  return {
    savingAuthorization: authorization.state === "loading",
    setAuthorization,
    commitAccountSelection,
    connecting:
      connectOperation.state === "loading" ||
      browserAuth.state === "loading" ||
      noAuth.state === "loading",
    isConnectorConnecting: (connectorSlug: ConnectorSlug) => {
      return (
        (connectExecution?.connectorSlug === connectorSlug &&
          connectOperation.state === "loading") ||
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
