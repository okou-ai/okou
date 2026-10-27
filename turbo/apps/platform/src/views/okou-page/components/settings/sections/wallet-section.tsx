import type { WalletConnectionStatus } from "@okouai/api-contracts/contracts/wallet";
import {
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  surfaceVariants,
} from "@okouai/ui";
import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { EllipsisVertical, Loader2, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { settingsActionSignal$ } from "../../../../../signals/okou-page/settings/settings-dialog.ts";
import {
  connectWallet$,
  disconnectWallet$,
  walletConnection$,
} from "../../../../../signals/okou-page/settings/wallet.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { ConnectedIndicator } from "../../connected-indicator.tsx";
import { ConnectorEntryStatus } from "../connector-entry-card.tsx";
import { WalletTransactions } from "../wallet-transactions.tsx";
import { WalletCards } from "../wallet-cards.tsx";

function WalletConnectionNotice({
  status,
  disabled,
  onReconnect,
}: {
  readonly status: WalletConnectionStatus | null;
  readonly disabled: boolean;
  readonly onReconnect: () => void;
}) {
  const { t } = useTranslation();
  if (
    status?.connectionStatus !== "scope-mismatch" &&
    status?.connectionStatus !== "reconnect-required"
  ) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      <ConnectorEntryStatus
        tone="warning"
        label={
          status.connectionStatus === "scope-mismatch"
            ? t(($) => {
                return $.connectors.card.updatePermissions;
              })
            : t(($) => {
                return $.connectors.accounts.reconnectRequired;
              })
        }
      />
      <span aria-hidden="true">·</span>
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-[13px]"
        disabled={disabled}
        onClick={onReconnect}
      >
        {t(($) => {
          return $.connectors.actions.reconnect;
        })}
      </Button>
    </div>
  );
}

function WalletActions({
  status,
  disabled,
  busy,
  disconnectOnly,
  onReconnect,
  onDisconnect,
}: {
  readonly status: WalletConnectionStatus;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly disconnectOnly: boolean;
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const hasConnection =
    status.connectionStatus !== "not-connected" || disconnectOnly;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {status.connected &&
        status.connectionStatus === "connected" &&
        !disconnectOnly && <ConnectedIndicator />}
      {busy && (
        <Loader2
          size={16}
          className="animate-spin text-muted-foreground"
          aria-label={t(($) => {
            return $.settings.shared.loading;
          })}
        />
      )}
      {!hasConnection && (
        <Button disabled={disabled} pending={busy} onClick={onReconnect}>
          {t(($) => {
            return $.settings.wallet.connect;
          })}
        </Button>
      )}
      {hasConnection && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                showTooltip
                type="button"
                variant="quiet"
                size="icon-xs"
                disabled={disabled}
                aria-label={t(($) => {
                  return $.settings.shared.moreOptions;
                })}
              />
            }
          >
            <EllipsisVertical size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!disconnectOnly && status.connectionStatus === "connected" && (
              <DropdownMenuItem disabled={disabled} onClick={onReconnect}>
                {t(($) => {
                  return $.connectors.actions.reconnect;
                })}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={disabled}
              className="text-destructive focus:text-destructive"
              onClick={onDisconnect}
            >
              {t(($) => {
                return $.settings.wallet.disconnect;
              })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function WalletSection() {
  const { t } = useTranslation();
  const connection = useLastLoadable(walletConnection$);
  const [connecting, connect] = useLoadableSet(connectWallet$);
  const [disconnecting, disconnect] = useLoadableSet(disconnectWallet$);
  const signal = useGet(settingsActionSignal$);
  const busy =
    connecting.state === "loading" || disconnecting.state === "loading";
  const status = connection.state === "hasData" ? connection.data : null;
  const disconnectOnly = Boolean(
    status?.revocationPending || disconnecting.state === "hasError",
  );
  const disabled = busy || !signal || signal.aborted;
  const failed =
    connecting.state === "hasError" || disconnecting.state === "hasError";
  const handleReconnect = () => {
    if (signal) {
      detach(connect(signal), Reason.DomCallback);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <Card
        role="region"
        aria-label={t(($) => {
          return $.connectors.callback.linkLabel;
        })}
        className={surfaceVariants({ className: "shrink-0 p-5" })}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex shrink-0 items-center gap-3">
            <Wallet
              size={22}
              className="shrink-0 text-foreground"
              aria-hidden="true"
            />
            <h3 className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.connectors.callback.linkLabel;
              })}
            </h3>
          </div>
          {status ? (
            <WalletActions
              status={status}
              disabled={disabled}
              busy={busy}
              disconnectOnly={disconnectOnly}
              onReconnect={handleReconnect}
              onDisconnect={() => {
                if (signal) {
                  detach(disconnect(signal), Reason.DomCallback);
                }
              }}
            />
          ) : connection.state === "loading" ? (
            <span role="status" className="text-sm text-muted-foreground">
              {t(($) => {
                return $.settings.shared.loading;
              })}
            </span>
          ) : null}
        </div>
        <div className="mt-3 space-y-2">
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.wallet.description;
            })}
          </p>
          <WalletConnectionNotice
            status={status}
            disabled={disabled || disconnectOnly}
            onReconnect={handleReconnect}
          />
        </div>
        {connection.state === "hasError" ? (
          <div className="mt-4 flex items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.settings.wallet.loadError;
              })}
            </p>
          </div>
        ) : failed ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {t(($) => {
              return $.settings.wallet.actionError;
            })}
          </p>
        ) : null}
      </Card>
      {status?.connected &&
        !status.revocationPending &&
        status.authorization?.capabilities.paymentMethods && <WalletCards />}
      <WalletTransactions />
    </div>
  );
}
