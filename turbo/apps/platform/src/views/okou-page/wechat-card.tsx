import { WorksChannelCardContent } from "./components/works-channel-card-content.tsx";
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
        className={surfaceVariants({ className: "flex min-w-0 flex-col" })}
      >
        <WorksChannelCardContent
          icon={<img src={wechatIconImg} alt="" className="size-5" />}
          title={t(($) => {
            return $.works.wechat.name;
          })}
          description={
            <>
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
              {status?.binding ? (
                <p className="mt-1 break-all">
                  {status.binding.workspace.name} · {status.binding.accountId}
                </p>
              ) : null}
            </>
          }
          actions={
            <>
              {connected ? (
                <ConnectedIndicator variant="text" wrap />
              ) : (
                <DialogTrigger
                  render={
                    <Button
                      variant="quiet"
                      size="xs"
                      className="shrink-0 gap-1.5 px-2 text-xs"
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
            </>
          }
        />
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
