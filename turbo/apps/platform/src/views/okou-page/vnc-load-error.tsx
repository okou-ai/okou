import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { retryVnc$ } from "../../signals/vnc.ts";

export function VncLoadError() {
  const { t } = useTranslation();
  const retry = useSet(retryVnc$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
    >
      <p>
        {t(($) => {
          return $.vnc.loadFailed;
        })}
      </p>
      <Button
        variant="outline"
        type="button"
        size="sm"
        onClick={() => {
          retry();
        }}
      >
        {t(($) => {
          return $.vnc.retry;
        })}
      </Button>
    </div>
  );
}
