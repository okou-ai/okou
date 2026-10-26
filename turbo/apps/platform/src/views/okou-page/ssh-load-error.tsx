import { useTranslation } from "react-i18next";
import { LoadErrorRow } from "@okouai/ui";

export function SshLoadError() {
  const { t } = useTranslation();
  return (
    <LoadErrorRow
      message={t(($) => {
        return $.ssh.loadFailed;
      })}
    />
  );
}
