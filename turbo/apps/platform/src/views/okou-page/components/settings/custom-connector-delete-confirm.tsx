import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import {
  closeCustomConnectorDialog$,
  deleteCustomConnector$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";

export function CustomConnectorDeleteConfirm({
  id,
  displayName,
}: {
  id: string;
  displayName: string;
}) {
  const { t } = useTranslation();
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const [loadable, submit] = useLoadableSet(deleteCustomConnector$);
  const signal = useGet(pageSignal$);
  const submitting = loadable.state === "loading";

  const onConfirm = () => {
    detach(submit(id, signal), Reason.DomCallback);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && closeDialog();
      }}
    >
      <DialogContent maxWidth="md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {t(
              ($) => {
                return $.connectors.custom.delete.title;
              },
              { connector: displayName },
            )}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.delete.description;
          })}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog} disabled={submitting}>
            {t(($) => {
              return $.connectors.actions.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting
              ? t(($) => {
                  return $.connectors.actions.deleting;
                })
              : t(($) => {
                  return $.connectors.actions.delete;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
