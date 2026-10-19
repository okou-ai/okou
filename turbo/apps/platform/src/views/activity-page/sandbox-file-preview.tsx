import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { Download, X } from "lucide-react";
import type { SandboxFilesSignals } from "../../signals/activity-page/sandbox-files.ts";
import type { FilePreviewFailure } from "../../lib/sandbox-file-preview.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { filesDirectoryKey } from "../../signals/activity-page/sandbox-files-virtual-list.ts";
import { ArtifactPreviewBody } from "../okou-page/attachment-chips.tsx";

function PreviewFailure({ error }: { readonly error: FilePreviewFailure }) {
  const { t } = useTranslation();
  switch (error) {
    case "unsupported": {
      return t(($) => {
        return $.activity.detail.files.previewUnsupported;
      });
    }
    case "size": {
      return t(($) => {
        return $.activity.detail.files.previewSize;
      });
    }
    case "invalid": {
      return t(($) => {
        return $.activity.detail.files.previewInvalid;
      });
    }
    case "decode": {
      return t(($) => {
        return $.activity.detail.files.previewDecode;
      });
    }
    case "changed": {
      return t(($) => {
        return $.activity.detail.files.previewChanged;
      });
    }
    case "updateRequired": {
      return t(($) => {
        return $.activity.detail.files.previewUpdateRequired;
      });
    }
    case "unavailable": {
      return t(($) => {
        return $.activity.detail.files.previewUnavailable;
      });
    }
  }
}

/** Keep the tooltip's DOM composition stable when Download becomes disabled. */
function PreviewDownloadButton({
  signals,
}: {
  readonly signals: SandboxFilesSignals;
}) {
  const { t } = useTranslation();
  const request = useGet(signals.preview.request$);
  const download = useSet(signals.download.start$);
  const busy = useGet(signals.download.busy$);
  const preparingPath = useGet(signals.download.preparingPath$);
  const signal = useGet(pageSignal$);
  const preparing =
    request !== null &&
    preparingPath !== null &&
    filesDirectoryKey(request.path) === filesDirectoryKey(preparingPath);
  const label = t(($) => {
    return $.artifacts.actions.download;
  });
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="icon-sm"
              focusableWhenDisabled
              disabled={busy || !request}
              pending={preparing}
              aria-label={label}
              onClick={() => {
                if (request) {
                  detach(download(request, signal), Reason.DomCallback);
                }
              }}
            >
              <Download size={18} />
            </Button>
          }
        />
        <TooltipContent>
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The preview's Download always enters the independent full-file transfer. */
export function SandboxFilePreviewDialog({
  signals,
}: {
  readonly signals: SandboxFilesSignals;
}) {
  const { t } = useTranslation();
  const request = useGet(signals.preview.request$);
  const result = useGet(signals.preview.result$);
  const close = useSet(signals.preview.close$);
  const finalFocus = useSet(signals.preview.finalFocus$);
  const initialFocus = useSet(signals.preview.initialFocus$);
  const popupRef = useSet(signals.preview.popupRef$);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent
        ref={popupRef}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        maxWidth={1440}
        height={1000}
        surface="canvas"
        contentClassName="flex flex-col gap-0 overflow-hidden bg-background p-0"
        showCloseButton={false}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-4">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">
            {request?.name}
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
            <PreviewDownloadButton signals={signals} />
            <DialogClose
              render={
                <IconButton
                  type="button"
                  className="opacity-70 hover:opacity-100"
                  aria-label={t(($) => {
                    return $.artifacts.actions.close;
                  })}
                />
              }
            >
              <X size={20} className="text-foreground" />
            </DialogClose>
          </div>
        </div>
        {result.status === "ready" && result.truncated && (
          <p
            role="status"
            className="shrink-0 border-b border-border/70 px-4 py-2 text-sm text-muted-foreground"
          >
            {t(($) => {
              return $.activity.detail.files.previewTruncated;
            })}
          </p>
        )}
        <DialogBody scrollable={false} className="overflow-hidden">
          {result.status === "ready" && result.preview ? (
            <ArtifactPreviewBody
              artifact={undefined}
              focusHtmlOnMount={false}
              fullscreen={false}
              imageCanvasSignals={signals.preview.imageCanvas}
              preview={result.preview}
              textMaxCharacters={65_536}
            />
          ) : (
            <div
              role={result.status === "error" ? "alert" : "status"}
              className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
            >
              {result.status === "error" ? (
                <PreviewFailure error={result.error} />
              ) : result.status === "loading" ? (
                t(($) => {
                  return $.activity.detail.files.previewLoading;
                })
              ) : (
                t(($) => {
                  return $.activity.detail.files.previewEmpty;
                })
              )}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
