import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { buttonVariants } from "@okouai/ui";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import {
  reconnectWechat$,
  wechatConnectPageStatus$,
} from "../../signals/okou-page/wechat-connect-signals.ts";
import { connectWechat$, wechatFlow$ } from "../../signals/okou-page/wechat.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  CenterText,
  ConnectCheckingState,
  ConnectErrorAlert,
  ConnectErrorState,
  ConnectInvalidLinkState,
  ConnectStatusMark,
  ConnectSubmitButton,
  PageShell,
  SettingsBackLink,
} from "./connect-page-shell.tsx";
import { WechatConnectForm } from "./wechat-connect-form.tsx";

export function WechatConnectPage() {
  return (
    <PageShell>
      <PageContent />
    </PageShell>
  );
}

function NewQrLink() {
  const { t } = useTranslation();
  return (
    <Link
      pathname={INTEGRATION_SETTINGS_PATHS.wechat}
      className={buttonVariants({ variant: "outline" })}
    >
      {t(($) => {
        return $.works.wechat.newQr;
      })}
    </Link>
  );
}

function PageContent() {
  const { t } = useTranslation();
  const status = useLoadable(wechatConnectPageStatus$);
  const flow = useGet(wechatFlow$);
  const signal = useGet(pageSignal$);
  const [connecting, connect] = useLoadableSet(connectWechat$);
  const start = () => {
    detach(connect("start", signal), Reason.DomCallback);
  };
  const mark = (
    <img src={settingsIconAssetUrl("wechat")} alt="" className="size-10" />
  );
  if (status.state === "hasError") {
    return (
      <ConnectErrorState
        message={t(($) => {
          return $.works.wechat.failed;
        })}
      />
    );
  }
  if (status.state !== "hasData") {
    return <ConnectCheckingState />;
  }
  const data = status.data;
  if (
    data.kind === "disabled" ||
    (data.kind === "overview" && !data.data?.configured)
  ) {
    return (
      <ConnectErrorState
        message={t(($) => {
          return $.works.wechat.unavailable;
        })}
      />
    );
  }
  if (data.kind === "invalid") {
    return (
      <>
        <ConnectInvalidLinkState
          description={t(($) => {
            return $.works.wechat.linkUnavailable;
          })}
        />
        <NewQrLink />
      </>
    );
  }
  if (data.kind === "reconnect") {
    return (
      <ReconnectContent
        account={data.account}
        workspace={data.workspace}
        agent={data.agent}
      />
    );
  }
  const connected = data.data?.status === "active";
  return (
    <>
      <ConnectStatusMark state={connected ? "success" : "idle"} idle={mark} />
      <CenterText
        title={
          connected
            ? t(($) => {
                return $.works.wechat.connected;
              })
            : t(($) => {
                return $.works.wechat.title;
              })
        }
        body={
          connected
            ? t(($) => {
                return $.works.wechat.returnToWechat;
              })
            : t(($) => {
                return $.works.wechat.instructions;
              })
        }
      />
      {!connected &&
        (flow.open ? (
          <WechatConnectForm
            loading={connecting.state === "loading"}
            failed={connecting.state === "hasError"}
            onStart={start}
            onVerify={() => {
              detach(connect("verify", signal), Reason.DomCallback);
            }}
          />
        ) : (
          <ConnectSubmitButton
            connecting={false}
            onConnect={start}
            label={t(($) => {
              return $.works.wechat.newQr;
            })}
          />
        ))}
      <SettingsBackLink />
    </>
  );
}

function ReconnectContent({
  account,
  workspace,
  agent,
}: {
  readonly account: string;
  readonly workspace: string | undefined;
  readonly agent: string;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [restoring, restore] = useLoadableSet(reconnectWechat$);
  return (
    <>
      <img src={settingsIconAssetUrl("wechat")} alt="" className="size-10" />
      <CenterText
        title={t(($) => {
          return $.works.wechat.title;
        })}
        body={t(($) => {
          return $.works.wechat.restoreDescription;
        })}
      />
      <dl className="w-full space-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.works.wechat.accountLabel;
            })}
          </dt>
          <dd className="break-words">{account}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.works.wechat.workspaceLabel;
            })}
          </dt>
          <dd className="break-words">{workspace}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.works.wechat.agentLabel;
            })}
          </dt>
          <dd className="break-words">{agent}</dd>
        </div>
      </dl>
      <ConnectErrorAlert
        error={
          restoring.state === "hasError"
            ? t(($) => {
                return $.works.wechat.linkUnavailable;
              })
            : null
        }
      />
      <ConnectSubmitButton
        connecting={restoring.state === "loading"}
        label={t(($) => {
          return $.works.wechat.reconnect;
        })}
        onConnect={() => {
          detach(restore(signal), Reason.DomCallback);
        }}
      />
      {restoring.state === "hasError" ? <NewQrLink /> : null}
      <SettingsBackLink />
    </>
  );
}
