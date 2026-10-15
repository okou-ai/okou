import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { MessagesSquare, CircleCheck, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button, surfaceVariants } from "@okouai/ui";
import { Input } from "@okouai/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  wechatStatus$,
  wechatFlow$,
  wechatCode$,
  setWechatCode$,
  startWechatConnect$,
  verifyWechat$,
  closeWechat$,
  disconnectWechat$,
} from "../../signals/okou-page/wechat.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function WechatCard() {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(wechatStatus$);
  const signal = useGet(pageSignal$);
  const [connecting, start] = useLoadableSet(startWechatConnect$);
  const [disconnecting, disconnect] = useLoadableSet(disconnectWechat$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const connected = status?.status === "active";
  const startConnection = () => {
    return detach(start(signal), Reason.DomCallback);
  };
  return (
    <>
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <MessagesSquare className="size-7 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.works.wechat.name;
              })}
            </div>
            <p className="text-sm text-muted-foreground">
              {status?.status === "reconnect_required"
                ? t(($) => {
                    return $.works.wechat.reconnect_required;
                  })
                : status && !status.configured
                  ? t(($) => {
                      return $.works.wechat.unavailable;
                    })
                  : t(($) => {
                      return $.works.wechat.description;
                    })}
            </p>
          </div>
          {connected ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheck className="size-3 text-green-600" />
              {t(($) => {
                return $.works.wechat.connected;
              })}
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!status?.configured || connecting.state === "loading"}
              onClick={startConnection}
            >
              {status?.status === "reconnect_required"
                ? t(($) => {
                    return $.works.wechat.reconnect;
                  })
                : t(($) => {
                    return $.works.wechat.connect;
                  })}
            </Button>
          )}
          {status && status.status !== "disconnected" ? (
            <Button
              variant="quiet"
              size="sm"
              disabled={disconnecting.state === "loading"}
              onClick={() => {
                return detach(disconnect(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.works.wechat.disconnect;
              })}
            </Button>
          ) : null}
        </div>
      </div>
      <WechatConnectDialog />
    </>
  );
}

function WechatConnectDialog() {
  const { t } = useTranslation();
  const flow = useGet(wechatFlow$);
  const signal = useGet(pageSignal$);
  const start = useSet(startWechatConnect$);
  const close = useSet(closeWechat$);
  const retry = [
    "expired",
    "verification_blocked",
    "restart_required",
    "failed",
  ].includes(flow.status);
  const startConnection = () => {
    return detach(start(signal), Reason.DomCallback);
  };
  return (
    <Dialog
      open={flow.open}
      onOpenChange={(open) => {
        if (!open) {
          detach(close(signal), Reason.DomCallback);
        }
      }}
    >
      <DialogContent smMaxWidth={440}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.works.wechat.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.works.wechat.instructions;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-4">
          {flow.status === "creating" ? (
            <Loader2 className="size-6 animate-spin" aria-hidden="true" />
          ) : null}
          {flow.attempt && !retry ? (
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG
                value={flow.attempt.qrContent}
                size={180}
                marginSize={2}
                title={t(($) => {
                  return $.works.wechat.title;
                })}
                data-testid="wechat-connect-qr"
              />
            </div>
          ) : null}
          <WechatFlowStatus retry={retry} />
          {flow.status === "verification_required" ? (
            <WechatVerificationForm />
          ) : null}
          {retry ? (
            <Button variant="outline" onClick={startConnection}>
              {t(($) => {
                return $.works.wechat.retry;
              })}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.works.wechat.scope;
          })}
        </p>
      </DialogContent>
    </Dialog>
  );
}

function WechatVerificationForm() {
  const { t } = useTranslation();
  const code = useGet(wechatCode$);
  const setCode = useSet(setWechatCode$);
  const signal = useGet(pageSignal$);
  const [verifying, verify] = useLoadableSet(verifyWechat$);
  return (
    <form
      className="flex w-full gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        detach(verify(signal), Reason.DomCallback);
      }}
    >
      <Input
        aria-label={t(($) => {
          return $.works.wechat.code;
        })}
        placeholder={t(($) => {
          return $.works.wechat.code;
        })}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={12}
        value={code}
        onChange={(event) => {
          return setCode(event.target.value);
        }}
      />
      <Button
        type="submit"
        disabled={!/^\d{4,12}$/u.test(code) || verifying.state === "loading"}
      >
        {t(($) => {
          return $.works.wechat.verify;
        })}
      </Button>
    </form>
  );
}

function WechatFlowStatus({ retry }: { readonly retry: boolean }) {
  const { t } = useTranslation();
  const flow = useGet(wechatFlow$);
  const statusMessages = {
    waiting: t(($) => {
      return $.works.wechat.waiting;
    }),
    scanned: t(($) => {
      return $.works.wechat.scanned;
    }),
    verification_required: t(($) => {
      return $.works.wechat.verification_required;
    }),
    verification_blocked: t(($) => {
      return $.works.wechat.verification_blocked;
    }),
    expired: t(($) => {
      return $.works.wechat.expired;
    }),
    connected: t(($) => {
      return $.works.wechat.connected;
    }),
    restart_required: t(($) => {
      return $.works.wechat.restart_required;
    }),
    creating: t(($) => {
      return $.works.wechat.creating;
    }),
    failed: t(($) => {
      return $.works.wechat.failed;
    }),
  };
  if (flow.status === "connected") {
    return null;
  }
  return (
    <p
      role={retry ? "alert" : "status"}
      className="text-center text-sm text-muted-foreground"
    >
      {statusMessages[flow.status]}
    </p>
  );
}
