import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { LoadErrorRow } from "@okouai/ui";
import { retrySsh$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function SshLoadError() {
  const { t } = useTranslation();
  const retry = useSet(retrySsh$);
  const signal = useGet(pageSignal$);
  return (
    <LoadErrorRow
      message={t(($) => {
        return $.ssh.loadFailed;
      })}
      retryLabel={t(($) => {
        return $.global.actions.tryAgain;
      })}
      onRetry={() => {
        detach(retry(signal), Reason.DomCallback);
      }}
    />
  );
}
