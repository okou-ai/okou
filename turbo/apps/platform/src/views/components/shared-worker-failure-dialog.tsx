import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";

import { sharedWorkerFailureDialogOpen$ } from "../../signals/shared-worker-failure.ts";

export function SharedWorkerFailureDialog() {
  const open = useGet(sharedWorkerFailureDialogOpen$);
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      onOpenChange={(_nextOpen, eventDetails) => {
        eventDetails.cancel();
      }}
    >
      <DialogContent maxWidth="md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.shared.workerFailure.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.shared.workerFailure.description;
            })}
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
