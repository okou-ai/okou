import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import type { SandboxFileDownloadSignals } from "../../signals/activity-page/sandbox-file-download.ts";

export function SandboxFileDownloadStatus({
  signals,
}: {
  readonly signals: SandboxFileDownloadSignals;
}) {
  const { t, i18n } = useTranslation();
  const available = useGet(signals.available$);
  const busy = useGet(signals.busy$);
  const view = useGet(signals.view$);
  const cancel = useSet(signals.cancel$);
  if (!available) {
    return (
      <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.activity.detail.files.downloadUnsupported;
        })}
      </p>
    );
  }
  if (!view) {
    return null;
  }
  const message = (() => {
    switch (view.phase) {
      case "starting": {
        return t(
          ($) => {
            return $.activity.detail.files.downloadStarting;
          },
          {
            name: view.name,
          },
        );
      }
      case "streaming": {
        return t(
          ($) => {
            return $.activity.detail.files.downloadProgress;
          },
          {
            name: view.name,
            received: new Intl.NumberFormat(i18n.resolvedLanguage).format(
              BigInt(view.received),
            ),
            total: new Intl.NumberFormat(i18n.resolvedLanguage).format(
              BigInt(view.total),
            ),
          },
        );
      }
      case "cancelling": {
        return t(($) => {
          return $.activity.detail.files.downloadCancelling;
        });
      }
      case "complete": {
        return t(($) => {
          return $.activity.detail.files.downloadComplete;
        });
      }
      case "cancelled": {
        return t(($) => {
          return $.activity.detail.files.downloadCancelled;
        });
      }
      case "changed": {
        return t(($) => {
          return $.activity.detail.files.downloadChanged;
        });
      }
      case "updateRequired": {
        return t(($) => {
          return $.activity.detail.files.downloadUpdateRequired;
        });
      }
      case "failed": {
        return t(($) => {
          return $.activity.detail.files.downloadFailed;
        });
      }
    }
  })();
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-4 py-2">
        <p
          role="status"
          className="min-w-0 flex-1 break-words text-sm text-muted-foreground"
        >
          {message}
        </p>
        {busy && view.phase !== "complete" && (
          <Button
            type="button"
            variant="quiet"
            size="sm"
            disabled={view.phase === "cancelling"}
            onClick={() => {
              return cancel();
            }}
          >
            {t(($) => {
              return $.activity.detail.files.downloadCancel;
            })}
          </Button>
        )}
      </div>
      {/* The confirmed first-party URL serves attachments. Sandboxing this navigation blocks WebKit downloads. */}
      {view.url && (
        <iframe
          key={view.url}
          src={view.url}
          title={t(($) => {
            return $.activity.detail.files.downloadFrame;
          })}
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
        />
      )}
    </>
  );
}
