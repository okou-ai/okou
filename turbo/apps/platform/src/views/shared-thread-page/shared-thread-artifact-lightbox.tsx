import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Download,
  Loader2,
  Maximize2,
  Minimize2,
  Share2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type {
  SharedThreadArtifactPreview,
  SharedThreadArtifactPreviewSignals,
} from "../../signals/shared-thread-page/shared-thread-artifact-preview.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ArtifactPreviewBody } from "../okou-page/attachment-chips.tsx";
import { artifactFallbackSubtitle } from "../okou-page/artifact-display.ts";

/** Public-share dialog, with no owner sharing, editing, or Drive actions. */
export function SharedThreadArtifactLightbox({
  signals,
}: {
  readonly signals: SharedThreadArtifactPreviewSignals;
}) {
  const current = useGet(signals.current$);
  return current ? (
    <SharedThreadArtifactDialog signals={signals} current={current} />
  ) : null;
}

function SharedThreadArtifactDialog({
  signals,
  current,
}: {
  readonly signals: SharedThreadArtifactPreviewSignals;
  readonly current: SharedThreadArtifactPreview;
}) {
  const { t } = useTranslation();
  const visible = useGet(signals.visible$);
  const fullscreen = useGet(signals.fullscreen$);
  const close = useSet(signals.close$);
  const finishClose = useSet(signals.finishClose$);
  const toggleFullscreen = useSet(signals.toggleFullscreen$);
  const [downloadState, download] = useLoadableSet(signals.download$);
  const resource = useLoadable(current.preview.resourceUrl$);
  const pageSignal = useGet(pageSignal$);
  return (
    <Dialog
      open={visible}
      onOpenChangeComplete={finishClose}
      onOpenChange={(open, details) => {
        if (!open && fullscreen && details.reason === "escape-key") {
          details.cancel();
          toggleFullscreen();
        } else if (!open) {
          close();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        maxWidth={1440}
        height={1000}
        surface="canvas"
        mode={fullscreen ? "fullscreen" : "windowed"}
        overlayClassName="[@media(display-mode:standalone)]:bottom-[calc(-1*var(--sab))] bg-gray-900/45 dark:bg-gray-900/45"
        contentClassName="flex flex-col gap-0 overflow-hidden bg-background p-0"
        data-testid="shared-thread-artifact-lightbox"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-medium">
              {current.title}
            </DialogTitle>
            <div
              role={downloadState.state === "hasError" ? "alert" : undefined}
              className="truncate text-xs text-muted-foreground"
            >
              {downloadState.state === "hasError"
                ? t(($) => {
                    return $.artifacts.toasts.downloadFailed;
                  })
                : artifactFallbackSubtitle(current.preview.kind, current.title)}
            </div>
          </div>
          <SharedThreadArtifactActions
            signals={signals}
            downloading={downloadState.state === "loading"}
            downloadAvailable={resource.state === "hasData"}
            onDownload={() => {
              detach(download(pageSignal), Reason.DomCallback);
            }}
          />
        </div>
        <DialogBody
          scrollable={false}
          className="overflow-hidden bg-background"
        >
          {resource.state === "hasError" ? (
            <div
              role="status"
              className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
            >
              {t(($) => {
                return $.artifacts.access.title;
              })}
            </div>
          ) : (
            <ArtifactPreviewBody
              artifact={undefined}
              focusHtmlOnMount={false}
              fullscreen={fullscreen}
              imageCanvasSignals={signals.imageCanvas}
              preview={current.preview}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function SharedThreadArtifactActions({
  signals,
  downloading,
  downloadAvailable,
  onDownload,
}: {
  readonly signals: SharedThreadArtifactPreviewSignals;
  readonly downloading: boolean;
  readonly downloadAvailable: boolean;
  readonly onDownload: () => void;
}) {
  const { t } = useTranslation();
  const fullscreen = useGet(signals.fullscreen$);
  const close = useSet(signals.close$);
  const toggleFullscreen = useSet(signals.toggleFullscreen$);
  const copyLink = useSet(signals.copyLink$);
  const pageSignal = useGet(pageSignal$);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        variant="quiet"
        size="icon-sm"
        showTooltip
        aria-label={t(($) => {
          return $.artifacts.sharing.copyLink;
        })}
        onClick={() => {
          detach(copyLink(pageSignal), Reason.DomCallback);
        }}
      >
        <Share2 size={18} />
      </Button>
      <Button
        variant="quiet"
        size="icon-sm"
        showTooltip
        disabled={downloading || !downloadAvailable}
        aria-label={t(($) => {
          return $.artifacts.actions.download;
        })}
        onClick={onDownload}
      >
        {downloading ? (
          <Loader2 size={18} className="animate-spin" />
        ) : (
          <Download size={18} />
        )}
      </Button>
      <Button
        variant="quiet"
        size="icon-sm"
        showTooltip
        aria-label={t(($) => {
          return fullscreen
            ? $.artifacts.actions.exitFullscreen
            : $.artifacts.actions.enterFullscreen;
        })}
        onClick={toggleFullscreen}
      >
        {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
      </Button>
      <Button
        variant="quiet"
        size="icon-sm"
        showTooltip
        aria-label={t(($) => {
          return $.artifacts.actions.close;
        })}
        onClick={close}
      >
        <X size={18} />
      </Button>
    </div>
  );
}
