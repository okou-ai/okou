import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button, surfaceVariants } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  wechatStatus$,
  wechatFlow$,
  connectWechat$,
  closeWechat$,
  disconnectWechat$,
} from "../../signals/okou-page/wechat.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ConnectedIndicator } from "./components/connected-indicator.tsx";
import { ProviderCardMenu } from "./components/provider-card-menu.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

import { WechatConnectForm } from "./wechat-connect-form.tsx";

const wechatIconImg = settingsIconAssetUrl("wechat");

export function WechatCard() {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(wechatStatus$);
  const signal = useGet(pageSignal$);
  const flow = useGet(wechatFlow$);
  const close = useSet(closeWechat$);
  const [connecting, connect] = useLoadableSet(connectWechat$);
  const [disconnecting, disconnect] = useLoadableSet(disconnectWechat$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const connected = status?.status === "active";
  const startConnection = () => {
    return detach(connect("start", signal), Reason.DomCallback);
  };
  return (
    <Dialog
      open={flow.open}
      onOpenChange={(open) => {
        if (open) {
          startConnection();
        } else {
          detach(close(signal), Reason.DomCallback);
        }
      }}
    >
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <img src={wechatIconImg} alt="" className="size-7 shrink-0" />
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
            {status?.binding ? (
              <p className="break-all text-sm text-muted-foreground">
                {status.binding.workspace.name} · {status.binding.accountId}
              </p>
            ) : null}
          </div>
          {connected ? (
            <ConnectedIndicator />
          ) : (
            <DialogTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 rounded-lg"
                />
              }
              disabled={!status?.configured}
            >
              {status?.status === "reconnect_required"
                ? t(($) => {
                    return $.works.wechat.reconnect;
                  })
                : t(($) => {
                    return $.works.wechat.connect;
                  })}
            </DialogTrigger>
          )}
          {status && status.status !== "disconnected" ? (
            <ProviderCardMenu
              moreOptionsLabel={t(($) => {
                return $.works.actions.moreOptions;
              })}
              disconnectLabel={t(($) => {
                return $.works.wechat.disconnect;
              })}
              disconnecting={disconnecting.state === "loading"}
              onDisconnect={() => {
                return detach(disconnect(signal), Reason.DomCallback);
              }}
            />
          ) : null}
        </div>
      </div>
      <WechatConnectDialog
        loading={connecting.state === "loading"}
        failed={connecting.state === "hasError"}
        onStart={startConnection}
        onVerify={() => {
          return detach(connect("verify", signal), Reason.DomCallback);
        }}
      />
    </Dialog>
  );
}

function WechatConnectDialog({
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
  return (
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
      <WechatConnectForm
        loading={loading}
        failed={failed}
        onStart={onStart}
        onVerify={onVerify}
      />
    </DialogContent>
  );
}
