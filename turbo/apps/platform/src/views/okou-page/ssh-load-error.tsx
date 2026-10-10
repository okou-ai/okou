import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { LoadErrorRow } from "@okouai/ui";
import { retrySsh$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function SshLoadError() {
  const { t } = useTranslation();
  // `retrySsh$` settles when the SSH selections are read again, so its state
  // is the in-flight state of the re-read this button started.
  const [retryLoadable, retry] = useLoadableSet(retrySsh$);
  const signal = useGet(pageSignal$);
  return (
    <LoadErrorRow
      message={t(($) => {
        return $.ssh.loadFailed;
      })}
      retryLabel={t(($) => {
        return $.global.actions.tryAgain;
      })}
      pending={retryLoadable.state === "loading"}
      onRetry={() => {
        detach(retry(signal), Reason.DomCallback);
      }}
    />
  );
}
