import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { retrySsh$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function SshLoadError() {
  const { t } = useTranslation();
  const retry = useSet(retrySsh$);
  const signal = useGet(pageSignal$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
    >
      <p>
        {t(($) => {
          return $.ssh.loadFailed;
        })}
      </p>
      <Button
        variant="outline"
        type="button"
        size="sm"
        onClick={() => {
          return detach(retry(signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.ssh.retry;
        })}
      </Button>
    </div>
  );
}
