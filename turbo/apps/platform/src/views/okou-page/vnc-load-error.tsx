import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { LoadErrorRow } from "@okouai/ui";
import { retryVnc$ } from "../../signals/vnc.ts";

export function VncLoadError() {
  const { t } = useTranslation();
  const retry = useSet(retryVnc$);
  return (
    <LoadErrorRow
      message={t(($) => {
        return $.vnc.loadFailed;
      })}
      retryLabel={t(($) => {
        return $.global.actions.tryAgain;
      })}
      onRetry={() => {
        retry();
      }}
    />
  );
}
