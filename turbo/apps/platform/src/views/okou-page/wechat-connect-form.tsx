import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@okouai/ui";
import { Input } from "@okouai/ui/components/ui/input";
import {
  wechatFlow$,
  wechatCode$,
  setWechatCode$,
} from "../../signals/okou-page/wechat.ts";

export function WechatConnectForm({
  loading,
  failed,
  onStart,
  onVerify,
}: {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly onStart: () => void;
  readonly onVerify: () => void;
}) {
  const { t } = useTranslation();
  const flow = useGet(wechatFlow$);
  const needsNewSession = [
    "expired",
    "verification_blocked",
    "restart_required",
  ].includes(flow.status);
  return (
    <>
      <div className="flex flex-col items-center gap-4 py-4">
        {loading && !flow.attempt ? (
          <Loader2 className="size-6 animate-spin" aria-hidden="true" />
        ) : null}
        {flow.attempt && !needsNewSession ? (
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG
              value={flow.attempt.qrContent}
              size={180}
              marginSize={2}
              aria-label={t(($) => {
                return $.works.wechat.title;
              })}
              data-testid="wechat-connect-qr"
            />
          </div>
        ) : null}
        <WechatFlowStatus failed={failed} />
        {flow.status === "verification_required" && !failed ? (
          <WechatVerificationForm loading={loading} onVerify={onVerify} />
        ) : null}
        {needsNewSession ? (
          <Button variant="outline" onClick={onStart} disabled={loading}>
            {t(($) => {
              return $.works.wechat.connect;
            })}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(($) => {
          return $.works.wechat.scope;
        })}
      </p>
    </>
  );
}

function WechatVerificationForm({
  loading,
  onVerify,
}: {
  readonly loading: boolean;
  readonly onVerify: () => void;
}) {
  const { t } = useTranslation();
  const code = useGet(wechatCode$);
  const setCode = useSet(setWechatCode$);

  return (
    <form
      className="flex w-full gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onVerify();
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
      <Button type="submit" disabled={!/^\d{4,12}$/u.test(code) || loading}>
        {t(($) => {
          return $.works.wechat.verify;
        })}
      </Button>
    </form>
  );
}

function WechatFlowStatus({ failed }: { readonly failed: boolean }) {
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
  };
  if (flow.status === "connected") {
    return null;
  }
  return (
    <p
      role={failed ? "alert" : "status"}
      className="text-center text-sm text-muted-foreground"
    >
      {failed
        ? t(($) => {
            return $.works.wechat.failed;
          })
        : !flow.attempt
          ? t(($) => {
              return $.works.wechat.creating;
            })
          : statusMessages[flow.status]}
    </p>
  );
}
