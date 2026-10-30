import type { ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  PreserveScrollAnchor,
} from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  attachmentDiagramPreview,
  completeLightboxDialogExit$,
  lightboxDialogFullscreen$,
  lightboxDialogInitialFocus$,
  lightboxDialogMountRef$,
  lightboxDialogVisible$,
  lightboxShareMenuOpen$,
  type AttachmentLightboxState,
} from "../../signals/okou-page/attachment-chips.ts";
import { closeArtifactCatalogPreview$ } from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import { ArtifactDiagramLightbox } from "../components/artifact-diagram-lightbox.tsx";

export function DialogIconButton({
  ariaLabel,
  children,
  onClick,
}: {
  ariaLabel: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      showTooltip
      type="button"
      onClick={onClick}
      variant="quiet"
      size="icon-sm"
      className="shrink-0"
      aria-label={ariaLabel}
    >
      {children}
    </Button>
  );
}

function useCloseArtifactPreview() {
  const rootSignal = useGet(rootSignal$);
  const closeArtifactCatalogPreview = useSet(closeArtifactCatalogPreview$);
  return () => {
    closeArtifactCatalogPreview(rootSignal);
  };
}

export function ArtifactPreviewCloseButton() {
  const { t } = useTranslation();
  const close = useCloseArtifactPreview();
  return (
    <DialogIconButton
      ariaLabel={t(($) => {
        return $.artifacts.actions.close;
      })}
      onClick={close}
    >
      <X size={18} />
    </DialogIconButton>
  );
}

export function ArtifactPreviewDialogFrame({
  ariaLabel,
  children,
  kind,
}: {
  ariaLabel: string;
  children: ReactNode;
  kind: AttachmentLightboxState["kind"];
}) {
  const dialogMountRef = useSet(lightboxDialogMountRef$);
  const initialFocus = useSet(lightboxDialogInitialFocus$);
  const completeDialogExit = useSet(completeLightboxDialogExit$);
  const closeWithAnimation = useCloseArtifactPreview();
  const visible = useGet(lightboxDialogVisible$);
  const fullscreen = useGet(lightboxDialogFullscreen$);
  const shareMenuOpen = useGet(lightboxShareMenuOpen$);

  return (
    <Dialog
      open={visible}
      onOpenChangeComplete={completeDialogExit}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && shareMenuOpen && details.reason === "escape-key") {
          // Hover does not move focus into the popover. Let its Base UI Escape
          // handler dismiss it before the surrounding preview can close.
          details.cancel();
          details.allowPropagation();
          return;
        }
        if (!nextOpen && visible) {
          closeWithAnimation();
        }
      }}
    >
      <DialogContent
        ref={dialogMountRef}
        initialFocus={initialFocus}
        showCloseButton={false}
        // The backdrop is fixed, so a standalone PWA clips it above the bottom
        // safe inset; extending `bottom` keeps it covering the screen edge.
        overlayClassName="[@media(display-mode:standalone)]:-bottom-safe bg-gray-900/45 dark:bg-gray-900/45"
        maxWidth={1440}
        height={1000}
        surface="canvas"
        mode={fullscreen ? "fullscreen" : "windowed"}
        contentClassName="flex flex-col gap-0 overflow-hidden bg-background p-0"
        aria-label={ariaLabel}
        data-testid="attachment-lightbox"
      >
        <PreserveScrollAnchor
          layoutKey={fullscreen}
          anchor={
            kind === "markdown"
              ? {
                  viewportSelector: '[data-testid="artifact-dialog-stage"]',
                  anchorSelector: "h1, h2, h3, h4, h5, h6, p, pre, li, tr",
                }
              : undefined
          }
        >
          {children}
        </PreserveScrollAnchor>
      </DialogContent>
      <ArtifactDiagramLightbox signals={attachmentDiagramPreview} />
    </Dialog>
  );
}
