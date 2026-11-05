import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ComposerConnectorSignals } from "../../signals/okou-page/connectors.ts";
import { builtinPollingOAuthDeviceAuthSlug$ } from "../../signals/okou-page/settings/connectors.ts";
import {
  connectBuiltinConnectorNoAuthAndContinue$,
  connectBuiltinConnectorOAuthAuthCodeAndContinue$,
} from "../../signals/okou-page/settings/connector-connect-continuation.ts";

export function useComposerConnectorActions(signals: ComposerConnectorSignals) {
  const [authorization, setAuthorization] = useLoadableSet(
    signals.setConnectorAuthorization$,
  );
  const [browserAuth, connectBrowserAuth] = useLoadableSet(
    connectBuiltinConnectorOAuthAuthCodeAndContinue$,
  );
  const [noAuth, connectNoAuth] = useLoadableSet(
    connectBuiltinConnectorNoAuthAndContinue$,
  );
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  return {
    savingAuthorization: authorization.state === "loading",
    setAuthorization,
    connecting: browserAuth.state === "loading" || noAuth.state === "loading",
    isConnectorConnecting: (connectorSlug: ConnectorSlug) => {
      return pollingDeviceAuthSlug === connectorSlug;
    },
    connectBrowserAuth,
    connectNoAuth,
  };
}

export type ComposerConnectorActions = ReturnType<
  typeof useComposerConnectorActions
>;
