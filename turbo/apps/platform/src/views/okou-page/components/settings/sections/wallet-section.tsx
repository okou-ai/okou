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

export function WalletSection() {
  const { t } = useTranslation();
  const connection = useLoadable(walletConnection$);
  const [connecting, connect] = useLoadableSet(connectWallet$);
  const [disconnecting, disconnect] = useLoadableSet(disconnectWallet$);
  const refresh = useSet(refreshWalletConnection$);
  const signal = useGet(settingsActionSignal$);
  const busy =
    connecting.state === "loading" || disconnecting.state === "loading";
  const connected = connection.state === "hasData" && connection.data.connected;
  const shouldDisconnect =
    connected ||
    (connection.state === "hasData" && connection.data.revocationPending) ||
    disconnecting.state === "hasError";
  const failed =
    (!connected && connecting.state === "hasError") ||
    disconnecting.state === "hasError";
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
          </div>
        </div>
        <Button
          variant={shouldDisconnect ? "neutral" : "default"}
          className="shrink-0"
          pending={busy}
          disabled={
            connection.state !== "hasData" || busy || !signal || signal.aborted
          }
          onClick={() => {
            if (signal) {
              detach(
                shouldDisconnect ? disconnect(signal) : connect(signal),
                Reason.DomCallback,
              );
            }
          }}
        >
          {shouldDisconnect
            ? t(($) => {
                return $.settings.wallet.disconnect;
              })
            : t(($) => {
                return $.settings.wallet.connect;
              })}
        </Button>
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
