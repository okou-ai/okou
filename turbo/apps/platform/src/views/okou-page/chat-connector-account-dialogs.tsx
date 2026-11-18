import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { useGet, useSet } from "ccstate-react";
import { BuiltinConnectorAccountDialogs } from "./builtin-connector-account-dialogs.tsx";
import { CustomAccountDialogs } from "./components/settings/custom-connectors-panel.tsx";
import { ConnectorAccountNameDialog } from "./components/settings/connector-account-name-dialog.tsx";

export function ChatConnectorAccountDialogs({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const active = useGet(signals.connector.chatAccess.accountManager.active$);
  const triggerElement = useGet(signals.connector.triggerElement$);
  const restoreFocus = useSet(
    signals.connector.chatAccess.accountManager.finalFocus$,
  );
  const finalFocus = () => {
    return restoreFocus(triggerElement);
  };
  return active ? (
    <>
      <BuiltinConnectorAccountDialogs finalFocus={finalFocus} />
      <CustomAccountDialogs finalFocus={finalFocus} />
      <ConnectorAccountNameDialog />
    </>
  ) : null;
}
