import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import {
  type WebsiteTemplateItem,
  findWebsiteTemplateItem,
} from "@okouai/core/website-template-items";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";

function WebsiteTemplatePreviewDialog({
  item,
  open,
  onOpenChange,
  onOpenChangeComplete,
  signals,
}: {
  item: WebsiteTemplateItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const previewLoaded = useGet(signals.template.websiteTemplatePreviewLoaded$);
  const markPreviewLoaded = useSet(
    signals.template.markWebsiteTemplatePreviewLoaded$,
  );
  const placeholderUrl = r2ImageTransformUrl(item.previewImageUrl, {
    width: 480,
    height: 270,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <DialogContent
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        maxWidth="6xl"
        height={760}
        contentClassName="flex flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="h-[68px] shrink-0 justify-center px-6 pr-14 text-left">
          <DialogTitle className="flex min-w-0 max-w-full items-center justify-start gap-1.5 text-left text-base leading-none">
            <button
              type="button"
              className="inline-flex shrink-0 items-center p-0 leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t(($) => {
                return $.artifacts.templates.website;
              })}
            </button>
            <span className="shrink-0 text-muted-foreground">/</span>
            <span className="block min-w-0 truncate leading-none">
              {item.title}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 px-6 pb-6 pt-0.5">
          <div className="relative h-full overflow-hidden rounded-xl border border-border bg-background">
            <img
              src={placeholderUrl}
              alt=""
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 z-10 h-full w-full bg-background object-contain object-top ${
                previewLoaded ? "hidden" : "block"
              }`}
            />
            <iframe
              title={t(
                ($) => {
                  return $.artifacts.templates.fullPreview;
                },
                {
                  title: item.title,
                },
              )}
              src={item.previewUrl}
              sandbox="allow-same-origin allow-scripts"
              className="h-full w-full border-0 bg-background"
              onLoad={markPreviewLoaded}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function WebsiteTemplatePreviewDialogSlot({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const previewId = useGet(signals.template.websiteTemplatePreviewId$);
  const open = useGet(signals.template.websiteTemplatePreviewOpen$);
  const closePreview = useSet(signals.template.closeWebsiteTemplatePreview$);
  const completeClose = useSet(
    signals.template.completeWebsiteTemplatePreviewClose$,
  );
  const item =
    previewId === null ? null : (findWebsiteTemplateItem(previewId) ?? null);

  if (item === null) {
    return null;
  }

  return (
    <WebsiteTemplatePreviewDialog
      item={item}
      open={open}
      signals={signals}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closePreview();
        }
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          completeClose();
        }
      }}
    />
  );
}
