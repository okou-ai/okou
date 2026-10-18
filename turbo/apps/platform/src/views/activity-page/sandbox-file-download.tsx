import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { SandboxFileDownloadSignals } from "../../signals/activity-page/sandbox-file-download.ts";

export function SandboxFileDownloadFrame({
  signals,
}: {
  readonly signals: SandboxFileDownloadSignals;
}) {
  const { t } = useTranslation();
  const url = useGet(signals.url$);
  if (!url) {
    return null;
  }
  return (
    // Sandboxing this first-party attachment navigation blocks WebKit downloads.
    <iframe
      key={url}
      src={url}
      title={t(($) => {
        return $.activity.detail.files.downloadFrame;
      })}
      referrerPolicy="no-referrer"
      tabIndex={-1}
      aria-hidden="true"
      className="hidden"
    />
  );
}
