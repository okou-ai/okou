import { useGet, useSet } from "ccstate-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  connectorConnectionProgressVisible$,
  cancelConnectorConnection$,
  connectorConnectionAttempt$,
} from "../../signals/connector-connection-progress.ts";
import { ConnectorConnectionStatus } from "./connector-connection-dialog-body.tsx";

export function ConnectorConnectionProgress() {
  const visible = useGet(connectorConnectionProgressVisible$);
  const cancelConnection = useSet(cancelConnectorConnection$);
  const attempt = useGet(connectorConnectionAttempt$);
  const cancel = () => {
    cancelConnection(attempt);
  };
  const { t } = useTranslation();

  return (
    <Dialog
      open={visible}
      onOpenChange={(open, details) => {
        if (!open && details.reason === "outside-press") {
          details.cancel();
          return;
        }
        if (!open) {
          cancel();
        }
      }}
    >
      <DialogContent
        maxWidth="md"
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.connectors.actions.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.connectors.connectionProgress.title;
            })}
          </DialogTitle>
        </DialogHeader>
        <ConnectorConnectionStatus />
      </DialogContent>
    </Dialog>
  );
}

/** Explicit close cancels owned work; accidental outside presses leave it running. */
export function useConnectorConnectionDialogClose(
  pending: boolean,
  onClose: () => void,
) {
  const cancelConnection = useSet(cancelConnectorConnection$);
  const attempt = useGet(connectorConnectionAttempt$);
  const close = () => {
    if (pending) {
      cancelConnection(attempt);
    }
    onClose();
  };
  const onOpenChange: NonNullable<
    ComponentProps<typeof Dialog>["onOpenChange"]
  > = (open, details) => {
    if (!open && pending && details.reason === "outside-press") {
      details.cancel();
      return;
    }
    if (!open) {
      close();
    }
  };
  return { close, onOpenChange };
}
