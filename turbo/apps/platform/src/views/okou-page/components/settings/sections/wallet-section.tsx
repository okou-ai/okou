import type { WalletConnectionStatus } from "@okouai/api-contracts/contracts/wallet";
import { Button, Card } from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { settingsActionSignal$ } from "../../../../../signals/okou-page/settings/settings-dialog.ts";
import {
  connectWallet$,
  disconnectWallet$,
  refreshWalletConnection$,
  walletConnection$,
} from "../../../../../signals/okou-page/settings/wallet.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { WalletScopeReviewDialog } from "../wallet-scope-review-dialog.tsx";

function WalletConnectionNotice({
  status,
}: {
  readonly status: WalletConnectionStatus | null;
}) {
  const { t } = useTranslation();
  if (
    status?.connectionStatus !== "scope-mismatch" &&
    status?.connectionStatus !== "reconnect-required"
  ) {
    return null;
  }
  return (
    <p
      role="status"
      className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
      {status.connectionStatus === "scope-mismatch"
        ? t(($) => {
            return $.connectors.card.updatePermissions;
          })
        : t(($) => {
            return $.connectors.accounts.reconnectRequired;
          })}
    </p>
  );
}

export function WalletSection() {
  const { t } = useTranslation();
  const connection = useLoadable(walletConnection$);
  const [connecting, connect] = useLoadableSet(connectWallet$);
  const [disconnecting, disconnect] = useLoadableSet(disconnectWallet$);
  const refresh = useSet(refreshWalletConnection$);
  const signal = useGet(settingsActionSignal$);
  const busy =
    connecting.state === "loading" || disconnecting.state === "loading";
  const status = connection.state === "hasData" ? connection.data : null;
  const hasConnection =
    status !== null && status.connectionStatus !== "not-connected";
  const disconnectOnly =
    status?.revocationPending || disconnecting.state === "hasError";
  const disabled = !status || busy || !signal || signal.aborted;
  const failed =
    connecting.state === "hasError" || disconnecting.state === "hasError";
  const reconnect = () => {
    if (signal) {
      detach(connect(signal), Reason.DomCallback);
    }
  };
  return (
    <Card className="rounded-3xl border-surface-border p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-start gap-4 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-50 text-foreground">
            <Wallet size={22} aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.connectors.callback.linkLabel;
              })}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.settings.wallet.description;
              })}
            </p>
            <WalletConnectionNotice status={status} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!disconnectOnly &&
            (status?.scopeChange ? (
              <WalletScopeReviewDialog
                change={status.scopeChange}
                disabled={disabled}
                onReconnect={reconnect}
              />
            ) : (
              <Button
                variant={
                  status?.connectionStatus === "connected"
                    ? "neutral"
                    : "default"
                }
                pending={connecting.state === "loading"}
                disabled={disabled}
                onClick={reconnect}
              >
                {hasConnection
                  ? t(($) => {
                      return $.connectors.actions.reconnect;
                    })
                  : t(($) => {
                      return $.settings.wallet.connect;
                    })}
              </Button>
            ))}
          {(hasConnection || disconnectOnly) && (
            <Button
              variant="neutral"
              pending={disconnecting.state === "loading"}
              disabled={disabled}
              onClick={() => {
                if (signal) {
                  detach(disconnect(signal), Reason.DomCallback);
                }
              }}
            >
              {t(($) => {
                return $.settings.wallet.disconnect;
              })}
            </Button>
          )}
        </div>
      </div>
      {connection.state === "hasError" ? (
        <div className="mt-4 flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.settings.wallet.loadError;
            })}
          </p>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              refresh();
            }}
          >
            {t(($) => {
              return $.settings.wallet.retry;
            })}
          </Button>
        </div>
      ) : failed ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t(($) => {
            return $.settings.wallet.actionError;
          })}
        </p>
      ) : null}
    </Card>
  );
}
