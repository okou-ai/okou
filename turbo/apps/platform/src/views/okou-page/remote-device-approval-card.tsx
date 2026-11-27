import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
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

function RemoteDeviceApprovalStatus({
  granted,
  unavailable,
  failure,
}: {
  readonly granted: boolean;
  readonly unavailable: boolean;
  readonly failure: "continuation" | "save" | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      {granted && (
        <p className="text-sm">
          {t(($) => {
            return $.remoteDevices.approved;
          })}
        </p>
      )}
      {unavailable && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteDevices.unavailable;
          })}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return failure === "continuation"
              ? $.remoteDevices.continuationFailed
              : $.remoteDevices.saveFailed;
          })}
        </p>
      )}
    </>
  );
}

function RemoteDeviceApprovalActions({
  confirmAccess,
  pending,
  presentation,
  onCancel,
  onConfirm,
}: {
  readonly confirmAccess: boolean;
  readonly pending: boolean;
  readonly presentation: "inline" | "dialog";
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!confirmAccess) {
    return (
      <Button size="sm" variant="neutral" onClick={onConfirm}>
        {t(($) => {
          return $.remoteDevices.continueTask;
        })}
      </Button>
    );
  }
  return (
    <>
      <Button size="sm" variant="neutral" disabled={pending} onClick={onCancel}>
        {t(($) => {
          return $.remoteDevices.cancel;
        })}
      </Button>
      <Button
        size="sm"
        pending={pending}
        className={
          presentation === "inline"
            ? "bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
            : undefined
        }
        onClick={onConfirm}
      >
        {t(($) => {
          return $.remoteDevices.allowOneHour;
        })}
      </Button>
    </>
  );
}

export function RemoteDeviceApprovalCard({
  signals,
  onCancel,
  presentation = "inline",
}: {
  readonly signals: RemoteDeviceApprovalSignals;
  readonly onCancel?: () => void;
  readonly presentation?: "inline" | "dialog";
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
  const failure =
    operation.state === "hasError"
      ? canContinue
        ? "continuation"
        : "save"
      : null;
  if (outcome === "cancelled") {
    return null;
  }
  const title = device
    ? t(
        ($) => {
          return $.remoteDevices.approvalTitle;
        },
        { device: device.displayName },
      )
    : t(($) => {
        return $.remoteDevices.approval;
      });
  const canApprove = outcome === "requested" && device !== undefined;
  const scope = canApprove && (
    <p className="text-sm text-muted-foreground">
      {t(($) => {
        return $.remoteDevices.grantScope;
      })}
    </p>
  );
  const status = (
    <RemoteDeviceApprovalStatus
      granted={outcome === "allowed" || outcome === "continued"}
      unavailable={
        outcome === "requested" && !device && load.state !== "loading"
      }
      failure={failure}
    />
  );
  const actions = (canApprove || (canContinue && !pending)) && (
    <RemoteDeviceApprovalActions
      confirmAccess={canApprove}
      pending={pending}
      presentation={presentation}
      onCancel={() => {
        cancel();
        onCancel?.();
      }}
      onConfirm={() => {
        detach(confirm(signal), Reason.DomCallback);
      }}
    />
  );

  if (presentation === "dialog") {
    return (
      <>
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="leading-snug break-words">
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2" aria-busy={load.state === "loading"}>
          <DialogDescription className="break-words whitespace-pre-line">
            {signals.action.reason}
          </DialogDescription>
          {scope}
          {status}
        </div>
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </>
    );
  }
  return (
    <ChatCard
      className="h-[216px] w-full @[640px]:h-[176px]"
      data-testid="remote-device-approval-card"
    >
      <div
        className="flex h-full min-h-0 flex-col gap-2 px-4 py-3"
        aria-busy={load.state === "loading"}
      >
        <div className="flex shrink-0 items-start gap-2">
          <Laptop
            size={16}
            aria-hidden
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <div
            className="min-w-0 max-h-16 overflow-y-auto break-words text-sm font-semibold"
            title={device?.displayName}
          >
            {title}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto break-words text-sm">
          <p className="whitespace-pre-line">{signals.action.reason}</p>
          {status}
        </div>
        {scope}
        {actions && (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {actions}
          </div>
        )}
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
          {signals?.action.originalUrl === link.originalUrl ? (
            <RemoteDeviceApprovalCard
              signals={signals}
              onCancel={close}
              presentation="dialog"
            />
          ) : (
            <DialogHeader>
              <DialogTitle>
                {t(($) => {
                  return $.remoteDevices.approval;
                })}
              </DialogTitle>
            </DialogHeader>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
