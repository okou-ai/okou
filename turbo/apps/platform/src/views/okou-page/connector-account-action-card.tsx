import {
  connectorAccountEffectiveLabel,
  connectorAccountExternalIdentity,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { Button, cn } from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type {
  ConnectorAccountActionSignals,
  ConnectorAccountActionStatus,
} from "../../signals/chat-page/connector-account-action-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";

export function ConnectorAccountActionCard({
  signals,
}: {
  readonly signals: ConnectorAccountActionSignals;
}) {
  // Keep the frame mounted while async states replace their content. WebKit can
  // clamp the chat's scroll position if the card collapses during a DOM commit.
  return (
    <ChatCard className="h-[136px] w-full sm:h-[88px]">
      <ConnectorAccountActionCardContent signals={signals} />
    </ChatCard>
  );
}

function ConnectorAccountActionCardContent({
  signals,
}: {
  readonly signals: ConnectorAccountActionSignals;
}) {
  const loadable = useLoadable(signals.status$);
  const last = useLastLoadable(signals.status$);
  if (loadable.state === "loading" && last.state !== "hasData") {
    return <ConnectorAccountActionCardLoading />;
  }
  if (loadable.state === "hasError" && last.state !== "hasData") {
    return <ConnectorAccountActionCardError signals={signals} />;
  }
  const status =
    loadable.state === "hasData"
      ? loadable.data
      : last.state === "hasData"
        ? last.data
        : null;
  return status ? (
    <LoadedConnectorAccountActionCard signals={signals} status={status} />
  ) : null;
}

function ConnectorAccountActionCardLoading() {
  return (
    <div
      data-testid="connector-account-action-card-loading"
      className="flex h-full w-full items-center justify-center p-3"
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function ConnectorAccountActionCardError({
  signals,
}: {
  readonly signals: ConnectorAccountActionSignals;
}) {
  const refresh = useSet(signals.refresh$);
  const { t } = useTranslation();
  return (
    <div
      data-testid="connector-account-action-card-error"
      className="flex h-full w-full items-center gap-3 p-3"
    >
      <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 line-clamp-3 text-sm leading-5 text-muted-foreground">
        {t(($) => {
          return $.chat.connectorAccountSwitch.loadFailed;
        })}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={refresh}
      >
        {t(($) => {
          return $.chat.connectorAccountSwitch.retry;
        })}
      </Button>
    </div>
  );
}

function LoadedConnectorAccountActionCard({
  signals,
  status,
}: {
  readonly signals: ConnectorAccountActionSignals;
  readonly status: ConnectorAccountActionStatus;
}) {
  if (status.kind === "unavailable") {
    return <UnavailableConnectorAccountActionCard />;
  }
  return <ReadyConnectorAccountActionCard signals={signals} status={status} />;
}

function UnavailableConnectorAccountActionCard() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="connector-account-action-card-unavailable"
      className="flex h-full w-full items-center gap-3 p-3"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
        <AlertCircle size={22} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[0.9375rem] font-medium leading-5 text-foreground">
          {t(($) => {
            return $.chat.connectorAccountSwitch.unavailableTitle;
          })}
        </div>
        <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
          {t(($) => {
            return $.chat.connectorAccountSwitch.unavailableDescription;
          })}
        </div>
      </div>
    </div>
  );
}

function accountTargetLabel(
  account: ConnectorAccountConnection,
  customConnectorLabel: string,
): string {
  return account.target.kind === "builtin"
    ? account.target.connectorSlug
    : `${customConnectorLabel} · ${account.target.customConnectorId.slice(0, 8)}`;
}

function ConnectorAccountActionNotice({
  reconnectRequired,
  switchFailed,
}: {
  readonly reconnectRequired: boolean;
  readonly switchFailed: boolean;
}) {
  const { t } = useTranslation();
  const accountStatus = [
    switchFailed
      ? t(($) => {
          return $.chat.connectorAccountSwitch.actionFailed;
        })
      : null,
    reconnectRequired
      ? t(($) => {
          return $.chat.connectorAccountSwitch.reconnectRequired;
        })
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return accountStatus ? (
    <div
      className={cn(
        "mt-1 truncate text-xs leading-4",
        switchFailed ? "text-destructive" : "text-muted-foreground",
      )}
      title={accountStatus}
    >
      {accountStatus}
    </div>
  ) : null;
}

function ReadyConnectorAccountActionCard({
  signals,
  status,
}: {
  readonly signals: ConnectorAccountActionSignals;
  readonly status: Extract<ConnectorAccountActionStatus, { kind: "ready" }>;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const confirmationState = useGet(signals.confirmationState$);
  const connectorLoadable = useLastLoadable(signals.connector$);
  const [, confirm] = useLoadableSet(signals.confirm$);
  const selected = status.selected;
  const switching = confirmationState === "loading";
  const switchFailed = confirmationState === "error" && !selected;
  const accountLabel = connectorAccountEffectiveLabel(
    status.account,
    t(($) => {
      return $.chat.connectorAccountSwitch.accountFallback;
    }),
  );
  const identity = connectorAccountExternalIdentity(status.account);
  const customConnectorLabel = t(($) => {
    return $.chat.connectorAccountSwitch.customConnector;
  });
  const target = accountTargetLabel(status.account, customConnectorLabel);
  const connector =
    connectorLoadable.state === "hasData" ? connectorLoadable.data : null;
  const connectorIcon =
    connector?.kind === "custom" ? (
      <CustomConnectorIcon
        id={connector.id}
        displayName={connector.displayName ?? customConnectorLabel}
        size={22}
      />
    ) : (
      <ConnectorIcon
        icon={connector?.kind === "builtin" ? connector.icon : undefined}
        size={22}
      />
    );

  return (
    <div
      data-testid="connector-account-action-card"
      className="flex h-full w-full flex-col justify-between gap-3 p-3 text-left sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
          {connectorIcon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[0.9375rem] font-medium leading-5 text-foreground">
            {selected ? (
              <Check
                size={15}
                className="shrink-0 text-emerald-600 dark:text-emerald-400"
              />
            ) : null}
            <span className="truncate">
              {selected
                ? t(
                    ($) => {
                      return $.chat.connectorAccountSwitch.selected;
                    },
                    { account: accountLabel },
                  )
                : t(
                    ($) => {
                      return $.chat.connectorAccountSwitch.title;
                    },
                    { account: accountLabel },
                  )}
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm leading-5 text-muted-foreground">
            {[target, identity && identity !== accountLabel ? identity : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <ConnectorAccountActionNotice
            reconnectRequired={
              status.account.connectionStatus === "reconnect-required"
            }
            switchFailed={switchFailed}
          />
        </div>
      </div>
      {selected ? null : (
        <Button
          size="sm"
          className="w-full shrink-0 sm:w-auto"
          disabled={switching}
          onClick={() => {
            detach(confirm(pageSignal), Reason.DomCallback);
          }}
        >
          {switching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {switching
            ? t(($) => {
                return $.chat.connectorAccountSwitch.switching;
              })
            : switchFailed
              ? t(($) => {
                  return $.chat.connectorAccountSwitch.retry;
                })
              : t(($) => {
                  return $.chat.connectorAccountSwitch.switch;
                })}
        </Button>
      )}
    </div>
  );
}
