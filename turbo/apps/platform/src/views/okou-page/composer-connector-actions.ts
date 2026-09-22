import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ComposerConnectorSignals } from "../../signals/okou-page/connectors.ts";
import {
  builtinConnectFlowSlugs$,
  connectBuiltinConnectorNoAuthAndSettle$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
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
  const connectBrowserAuth = useSet(
    connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  );
  const connectNoAuth = useSet(connectBuiltinConnectorNoAuthAndSettle$);
  const connectingSlugs = useGet(builtinConnectFlowSlugs$);
  return {
    savingAuthorization: authorization.state === "loading",
    setAuthorization,
    savingAccount:
      account.state === "loading" || defaultAccount.state === "loading",
    selectAccount,
    useDefaultAccount,
    connecting: connectingSlugs.size > 0,
    connectBrowserAuth,
    connectNoAuth,
  };
}

export type ComposerConnectorActions = ReturnType<
  typeof useComposerConnectorActions
>;
