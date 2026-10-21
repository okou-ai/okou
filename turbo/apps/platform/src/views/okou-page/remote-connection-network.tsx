import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  LoadErrorRow,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import {
  remoteSetupNetworks$,
  retryRemoteSetupNetworks$,
  updateRemoteSetup$,
} from "../../signals/remote-control-setup.ts";
import {
  chooseSshConnectionMode$,
  chooseSshTailscaleConfig$,
  chooseSshAccessConfig$,
  sshConnectionModeEditor$,
} from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

function NetworkOptions({
  items,
  isEmpty,
}: {
  readonly items: readonly { readonly value: string; readonly label: string }[];
  readonly isEmpty: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SelectContent>
      {items.map((item) => {
        return (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        );
      })}
      {isEmpty && (
        <>
          <SelectSeparator />
          <SelectItem
            value="unavailable-private-network"
            disabled
            aria-describedby="remote-network-guidance"
          >
            {t(($) => {
              return $.remoteControlSetup.networkTitle;
            })}
          </SelectItem>
          <p
            id="remote-network-guidance"
            className="px-2 pb-2 text-xs leading-relaxed text-muted-foreground"
          >
            {t(($) => {
              return $.remoteControlSetup.networkManagementHelp;
            })}
          </p>
        </>
      )}
    </SelectContent>
  );
}

export function RemoteConnectionNetwork({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const networks = useLoadable(remoteSetupNetworks$);
  const retry = useSet(retryRemoteSetupNetworks$);
  const editor = useGet(sshConnectionModeEditor$);
  const chooseMode = useSet(chooseSshConnectionMode$);
  const chooseTailscale = useSet(chooseSshTailscaleConfig$);
  const chooseAccess = useSet(chooseSshAccessConfig$);
  const update = useSet(updateRemoteSetup$);
  const signal = useGet(pageSignal$);
  const available = networks.state === "hasData" ? networks.data : [];
  const isEmpty = networks.state === "hasData" && available.length === 0;
  const items = [
    {
      value: "direct",
      label: t(($) => {
        return $.remoteControlSetup.direct;
      }),
    },
    ...available.map((network) => {
      return {
        value: `${network.route}:${network.id}`,
        label: `${network.name} · ${network.route === "tailscale" ? "Tailscale" : "Cloudflare Access"}`,
      };
    }),
  ];
  const selected =
    editor.mode === "direct"
      ? "direct"
      : `${editor.mode}:${editor.mode === "tailscale" ? editor.tailscaleConfigId : editor.configId}`;
  const ready = items.some((item) => {
    return item.value === selected;
  });
  return (
    <div className="grid gap-2">
      <label htmlFor="remote-connection-network">
        {t(($) => {
          return $.remoteControlSetup.connectionNetwork;
        })}
      </label>
      <Select
        items={items}
        value={ready ? selected : null}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === "direct") {
            chooseMode("direct");
            update({ route: "direct", networkId: "" });
          } else {
            const network = available.find((item) => {
              return `${item.route}:${item.id}` === value;
            });
            if (network) {
              chooseMode(network.route);
              if (network.route === "tailscale") {
                chooseTailscale(network.id);
              } else {
                chooseAccess(network.id);
              }
              update({ route: network.route, networkId: network.id });
            }
          }
        }}
      >
        <SelectTrigger id="remote-connection-network">
          <SelectValue
            placeholder={t(($) => {
              return $.remoteControlSetup.network;
            })}
          />
        </SelectTrigger>
        <NetworkOptions items={items} isEmpty={isEmpty} />
      </Select>
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
      {networks.state === "hasData" && !ready && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.remoteControlSetup.networkUnavailable;
          })}
        </p>
      )}
    </div>
  );
}
