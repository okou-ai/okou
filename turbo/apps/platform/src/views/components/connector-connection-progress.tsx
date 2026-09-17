import { useGet, useSet } from "ccstate-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui/components/ui/button";
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
  connectorConnectionCompleted$,
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
        <ConnectorConnectionCancelButton />
      </DialogContent>
    </Dialog>
  );
}

export function ConnectorConnectionCancelButton({
  onCancel,
}: {
  readonly onCancel?: () => void;
}) {
  const cancelConnection = useSet(cancelConnectorConnection$);
  const attempt = useGet(connectorConnectionAttempt$);
  const completed = useGet(connectorConnectionCompleted$);
  const { t } = useTranslation();
  if (attempt === null) {
    return null;
  }
  return (
    <div className="flex justify-end">
      <Button
        variant="outline"
        onClick={() => {
          cancelConnection(attempt);
          onCancel?.();
        }}
      >
        {completed
          ? t(($) => {
              return $.connectors.actions.close;
            })
          : t(($) => {
              return $.connectors.actions.cancel;
            })}
      </Button>
    </div>
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
