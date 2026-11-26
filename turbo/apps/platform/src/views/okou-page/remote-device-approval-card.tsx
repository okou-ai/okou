import { Button, Dialog, DialogContent, DialogTitle } from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Laptop } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  closeRemoteDeviceApprovalLink$,
  mountRemoteDeviceApprovalLink$,
  remoteDeviceApprovalLink$,
  remoteDeviceApprovalLinkSignals$,
  type RemoteDeviceApprovalSignals,
} from "../../signals/chat-page/remote-device-approval-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

export function RemoteDeviceApprovalCard({
  signals,
  onCancel,
}: {
  readonly signals: RemoteDeviceApprovalSignals;
  readonly onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const load = useLoadable(signals.device$);
  const lastDevice = useLastResolved(signals.device$);
  const device = load.state === "hasData" ? load.data : lastDevice;
  const outcome = useGet(signals.outcome$);
  const cancel = useSet(signals.cancel$);
  const [operation, confirm] = useLoadableSet(signals.confirm$);
  const pending = operation.state === "loading";
  const canContinue =
    outcome === "allowed" && signals.action.callbackPrompt !== null;
  if (outcome === "cancelled") {
    return null;
  }
  return (
    <ChatCard
      className="h-[216px] w-full @[640px]:h-[176px]"
      data-testid="remote-device-approval-card"
    >
      <div
        className="flex h-full min-h-0 items-start gap-3 px-4 py-3"
        aria-busy={load.state === "loading"}
      >
        <Laptop
          size={20}
          aria-hidden
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
        <div className="flex h-full min-w-0 flex-1 flex-col gap-2">
          <div
            className="truncate text-sm font-medium"
            title={device?.displayName}
          >
            {device
              ? t(
                  ($) => {
                    return $.remoteDevices.approvalTitle;
                  },
                  { device: device.displayName },
                )
              : t(($) => {
                  return $.remoteDevices.approval;
                })}
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto break-words text-sm text-muted-foreground">
            <p className="whitespace-pre-line">{signals.action.reason}</p>
            {outcome === "requested" && device && (
              <p>
                {t(($) => {
                  return $.remoteDevices.grantScope;
                })}
              </p>
            )}
          </div>
          <div className="grid min-h-9 justify-items-start gap-1">
            {(outcome === "allowed" || outcome === "continued") && (
              <p className="text-sm">
                {t(($) => {
                  return $.remoteDevices.approved;
                })}
              </p>
            )}
            {outcome === "requested" && !device && load.state !== "loading" && (
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.remoteDevices.unavailable;
                })}
              </p>
            )}
            {operation.state === "hasError" && (
              <p role="alert" className="text-sm text-destructive">
                {t(($) => {
                  return canContinue
                    ? $.remoteDevices.continuationFailed
                    : $.remoteDevices.saveFailed;
                })}
              </p>
            )}
            {outcome === "requested" && device && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    cancel();
                    onCancel?.();
                  }}
                >
                  {t(($) => {
                    return $.remoteDevices.cancel;
                  })}
                </Button>
                <Button
                  size="sm"
                  pending={pending}
                  onClick={() => {
                    detach(confirm(signal), Reason.DomCallback);
                  }}
                >
                  {t(($) => {
                    return $.remoteDevices.allowOneHour;
                  })}
                </Button>
              </div>
            )}
            {canContinue && !pending && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  detach(confirm(signal), Reason.DomCallback);
                }}
              >
                {t(($) => {
                  return $.remoteDevices.continueTask;
                })}
              </Button>
            )}
          </div>
        </div>
      </div>
    </ChatCard>
  );
}

export function RemoteDeviceApprovalLinkDialog() {
  const { t } = useTranslation();
  const link = useGet(remoteDeviceApprovalLink$);
  const signals = useGet(remoteDeviceApprovalLinkSignals$);
  const mount = useSet(mountRemoteDeviceApprovalLink$);
  const close = useSet(closeRemoteDeviceApprovalLink$);
  if (!link) {
    return null;
  }
  return (
    <>
      <span key={link.originalUrl} hidden ref={mount} />
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            close();
          }
        }}
      >
        <DialogContent>
          <DialogTitle className="sr-only">
            {t(($) => {
              return $.remoteDevices.approval;
            })}
          </DialogTitle>
          {signals?.action.originalUrl === link.originalUrl && (
            <RemoteDeviceApprovalCard signals={signals} onCancel={close} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
