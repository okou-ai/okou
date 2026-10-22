import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { ArrowRight, Network } from "lucide-react";
import {
  Button,
  Card,
  LoadErrorRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  surfaceVariants,
} from "@okouai/ui";
import {
  addComputerNetwork$,
  enterRemoteSetup$,
  remoteSetup$,
  remoteComputerNetworks$,
  updateRemoteSetup$,
} from "../../signals/remote-control-setup.ts";
import { retryTailscale$ } from "../../signals/tailscale.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";

function ComputerNetworkSelection() {
  const { t } = useTranslation();
  const networks = useLoadable(remoteComputerNetworks$);
  const setup = useGet(remoteSetup$);
  const update = useSet(updateRemoteSetup$);
  const enter = useSet(enterRemoteSetup$);
  const retry = useSet(retryTailscale$);
  const signal = useGet(pageSignal$);
  const available = networks.state === "hasData" ? networks.data : [];
  const selected = available.find((network) => {
    return network.id === setup?.networkId && network.route === setup.route;
  });
  const items = available.map((network) => {
    return {
      value: `${network.route}:${network.id}`,
      label: network.name,
    };
  });
  return (
    <div className="grid gap-5">
      {networks.state === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.loading;
          })}
        </p>
      )}
      {networks.state === "hasError" && (
        <LoadErrorRow
          message={t(($) => {
            return $.remoteControlSetup.failedLoad;
          })}
          retryLabel={t(($) => {
            return $.remoteControlSetup.retry;
          })}
          onRetry={() => {
            return retry(signal);
          }}
        />
      )}
      {available.length > 0 && (
        <div className="grid gap-2">
          <label htmlFor="computer-network" className="text-sm">
            {t(($) => {
              return $.remoteControlSetup.network;
            })}
          </label>
          <Select
            items={items}
            value={selected ? `${selected.route}:${selected.id}` : null}
            onValueChange={(value) => {
              const network = available.find((item) => {
                return `${item.route}:${item.id}` === value;
              });
              if (network) {
                update({ route: network.route, networkId: network.id });
              }
            }}
          >
            <SelectTrigger id="computer-network">
              <SelectValue
                placeholder={t(($) => {
                  return $.remoteComputerSetup.selectNetwork;
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => {
                return (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
      {networks.state !== "loading" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-divider pt-5">
          <AddComputerNetwork primary={available.length === 0} />
          {available.length > 0 && (
            <Button
              className={REMOTE_PAGE_ACTION}
              disabled={!selected}
              onClick={() => {
                if (selected) {
                  enter("ssh", selected, true);
                }
              }}
            >
              {t(($) => {
                return $.remoteComputerSetup.continue;
              })}
              <ArrowRight size={16} aria-hidden />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function AddComputerNetwork({ primary }: { readonly primary: boolean }) {
  const { t } = useTranslation();
  const [opening, open] = useLoadableSet(addComputerNetwork$);
  const signal = useGet(pageSignal$);
  return (
    <div className="grid gap-2">
      <Button
        variant={primary ? "default" : "outline"}
        className={primary ? REMOTE_PAGE_ACTION : "min-h-10"}
        pending={opening.state === "loading"}
        onClick={() => {
          detach(open(signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.remoteComputerSetup.addNetwork;
        })}
        {primary && <ArrowRight size={16} aria-hidden />}
      </Button>
      {opening.state === "hasError" && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.remoteControlSetup.failedLoad;
          })}
        </p>
      )}
    </div>
  );
}

export function RemoteComputerNetwork() {
  const { t } = useTranslation();
  const networks = useLoadable(remoteComputerNetworks$);
  const empty = networks.state === "hasData" && networks.data.length === 0;
  return (
    <Card className={surfaceVariants({ className: "grid gap-6 p-6 text-sm" })}>
      <header className="grid gap-2.5">
        <h2 className="text-base font-semibold">
          {t(($) => {
            return $.remoteComputerSetup.networkStep;
          })}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(($) => {
            return empty
              ? $.remoteComputerSetup.networkEmptyDescription
              : $.remoteComputerSetup.networkDescription;
          })}
        </p>
      </header>
      <ComputerNetworkSelection />
    </Card>
  );
}

/** A selected computer network stays fixed throughout the connection form. */
export function ComputerNetworkSummary() {
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  const networks = useLoadable(remoteComputerNetworks$);
  const retry = useSet(retryTailscale$);
  const signal = useGet(pageSignal$);
  const selected =
    networks.state === "hasData"
      ? networks.data.find((network) => {
          return network.id === setup?.networkId;
        })
      : undefined;
  if (networks.state === "hasError") {
    return (
      <LoadErrorRow
        message={t(($) => {
          return $.remoteControlSetup.failedLoad;
        })}
        retryLabel={t(($) => {
          return $.remoteControlSetup.retry;
        })}
        onRetry={() => {
          return retry(signal);
        }}
      />
    );
  }
  if (networks.state === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.loading;
        })}
      </p>
    );
  }
  if (!selected) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t(($) => {
          return $.remoteControlSetup.networkUnavailable;
        })}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Network size={16} className="shrink-0" aria-hidden />
      <span>
        {t(
          ($) => {
            return $.remoteComputerSetup.usingNetwork;
          },
          { name: selected.name },
        )}
      </span>
    </p>
  );
}
