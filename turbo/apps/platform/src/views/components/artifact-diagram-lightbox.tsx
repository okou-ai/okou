import { Button, Dialog, DialogContent, DialogTitle } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Download, Loader2, Maximize2, Minimize2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ArtifactDiagramPreview,
  ArtifactDiagramPreviewSignals,
} from "../../signals/artifact-diagram-preview.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactImageNavigationRegion } from "../okou-page/artifact-image-navigation-region.tsx";
import { ArtifactImageZoomControls } from "../okou-page/artifact-actions.tsx";
import { ZoomableArtifactImageCanvas } from "../okou-page/zoomable-image-canvas.tsx";

interface ArtifactDiagramLightboxProps {
  readonly signals: ArtifactDiagramPreviewSignals;
  readonly portalContainer?: HTMLElement | null;
}

export function ArtifactDiagramLightbox(props: ArtifactDiagramLightboxProps) {
  const current = useGet(props.signals.current$);
  return current ? (
    <ArtifactDiagramDialog key={current.url} {...props} current={current} />
  ) : null;
}

function ArtifactDiagramDialog({
  signals,
  portalContainer,
  current,
}: ArtifactDiagramLightboxProps & {
  readonly current: ArtifactDiagramPreview;
}) {
  const visible = useGet(signals.visible$);
  const expanded = useGet(signals.expanded$);
  const close = useSet(signals.close$);
  const finishClose = useSet(signals.finishClose$);
  const restoreFocus = useSet(signals.restoreFocus$);

  return (
    <Dialog
      open={visible}
      onOpenChangeComplete={(open) => {
        finishClose(current, open);
      }}
      onOpenChange={(open, details) => {
        if (open) {
          return;
        }
        if (
          details.reason === "escape-key" &&
          portalContainer &&
          portalContainer.ownerDocument.fullscreenElement === portalContainer
        ) {
          // The browser owns native Escape. Its fullscreenchange must leave
          // this overlay open, including when keydown precedes that event.
          details.cancel();
          return;
        }
        close();
      }}
    >
      <DialogContent
        portalContainer={portalContainer}
        finalFocus={() => {
          return restoreFocus(current);
        }}
        showCloseButton={false}
        maxWidth={1440}
        height={1000}
        mode={expanded ? "fullscreen" : "windowed"}
        surface="canvas"
        contentClassName="flex flex-col gap-0 overflow-hidden bg-background p-0"
        data-testid="artifact-diagram-lightbox"
      >
        <ArtifactDiagramHeader signals={signals} filename={current.filename} />
        <ArtifactImageNavigationRegion
          signals={signals.imageCanvas}
          filename={current.filename}
          testIdPrefix="artifact-diagram"
        >
          <ZoomableArtifactImageCanvas
            key={current.url}
            src={current.url}
            alt={current.filename}
            signals={signals.imageCanvas}
            imageTestId="attachment-lightbox-image"
            canvasTestId="artifact-diagram-image-stage"
            contentClassName="p-6"
            pendingContent={<Loader2 className="animate-spin" aria-hidden />}
          >
            {(controls) => {
              return (
                <ArtifactImageZoomControls
                  controls={controls}
                  nativeTitle
                  testIdPrefix="artifact-diagram"
                />
              );
            }}
          </ZoomableArtifactImageCanvas>
        </ArtifactImageNavigationRegion>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactDiagramHeader({
  signals,
  filename,
}: {
  readonly signals: ArtifactDiagramPreviewSignals;
  readonly filename: string;
}) {
  const { t } = useTranslation();
  const expanded = useGet(signals.expanded$);
  const close = useSet(signals.close$);
  const toggleExpanded = useSet(signals.toggleExpanded$);
  const [downloadState, download] = useLoadableSet(signals.download$);
  const pageSignal = useGet(pageSignal$);
  const closeLabel = t(($) => {
    return $.artifacts.actions.close;
  });
  const expandLabel = t(($) => {
    return expanded ? $.shared.mermaid.restoreView : $.shared.mermaid.fillView;
  });
  const downloadLabel = t(($) => {
    return $.artifacts.actions.download;
  });

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-3">
        <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">
          {filename}
        </DialogTitle>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={downloadLabel}
          title={downloadLabel}
          disabled={downloadState.state === "loading"}
          onClick={() => {
            detach(download(pageSignal), Reason.DomCallback);
          }}
        >
          {downloadState.state === "loading" ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Download size={18} />
          )}
        </Button>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={expandLabel}
          title={expandLabel}
          onClick={toggleExpanded}
        >
          {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </Button>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={close}
        >
          <X size={18} />
        </Button>
      </div>
      {downloadState.state === "hasError" && (
        <div role="alert" className="px-4 py-2 text-sm text-destructive">
          {t(($) => {
            return $.artifacts.toasts.downloadFailed;
          })}
        </div>
      )}
    </>
  );
}
