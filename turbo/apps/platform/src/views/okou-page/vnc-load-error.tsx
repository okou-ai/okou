import { useTranslation } from "react-i18next";
import { LoadErrorRow } from "@okouai/ui";

export function VncLoadError() {
  const { t } = useTranslation();
  return (
    <LoadErrorRow
      message={t(($) => {
        return $.vnc.loadFailed;
      })}
    />
  );
}
