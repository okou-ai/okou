import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import type { UserTemplateCatalogEntry } from "@okouai/api-contracts/contracts/user-templates";
import {
  cancelDeleteCustomTemplate$,
  openCustomTemplateKind$,
  pendingCustomTemplateDeletion$,
} from "../../signals/okou-page/custom-template-library.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { CustomTemplatePreviewDialog } from "./custom-template-preview-dialog.tsx";

/** A recommendation opens its detail directly, without a catalog underneath. */
export function CustomTemplatePreviewSlot({
  signals,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const open = useGet(signals.template.templatePreviewOpen$);
  const close = useSet(signals.template.closeTemplatePreview$);
  const completeClose = useSet(signals.template.completeTemplatePreviewClose$);
  const returnFocus = useSet(signals.template.templatePreviewFinalFocus$);
  const pending = useGet(pendingCustomTemplateDeletion$);
  return (
    <CustomTemplatePreviewDialog
      open={open}
      onSelect={onSelect}
      returnFocus={returnFocus}
      onClose={close}
      onCloseComplete={completeClose}
    >
      {pending ? (
        <CustomTemplateDeleteConfirm
          key={pending.id}
          signals={signals}
          templateId={pending.id}
          title={pending.title}
          returnFocus={returnFocus}
        />
      ) : null}
    </CustomTemplatePreviewDialog>
  );
}

/** Only a successful deletion closes the detail; failures remain retryable. */
function CustomTemplateDeleteConfirm({
  signals,
  templateId,
  title,
  returnFocus,
}: {
  readonly signals: ComposerSignals;
  readonly templateId: string;
  readonly title: string;
  readonly returnFocus: (interactionType: string) => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const cancel = useSet(cancelDeleteCustomTemplate$);
  const [deleteLoadable, deleteTemplate] = useLoadableSet(
    signals.template.deleteCustomTemplate$,
  );
  const deleting = deleteLoadable.state === "loading";
  const previewKind = useGet(openCustomTemplateKind$);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !deleting) {
          cancel();
        }
      }}
    >
      <DialogContent
        smMaxWidth={420}
        finalFocus={previewKind === null ? returnFocus : undefined}
      >
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="break-words leading-tight">
            {t(($) => {
              return $.templates.delete.title;
            })}
          </DialogTitle>
          <DialogDescription className="break-words">
            {t(
              ($) => {
                return $.templates.delete.description;
              },
              { title },
            )}
          </DialogDescription>
        </DialogHeader>
        {deleteLoadable.state === "hasError" ? (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.templates.delete.failed;
            })}
          </p>
        ) : null}
        <DialogFooter className="min-w-0">
          <Button variant="outline" disabled={deleting} onClick={cancel}>
            {t(($) => {
              return $.templates.delete.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              detach(
                deleteTemplate(templateId, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {deleting
              ? t(($) => {
                  return $.templates.delete.deleting;
                })
              : t(($) => {
                  return $.templates.delete.confirm;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
