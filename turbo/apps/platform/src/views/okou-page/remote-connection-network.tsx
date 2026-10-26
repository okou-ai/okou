import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { SshConnectionMode } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  LoadErrorRow,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import {
  remoteSetupNetworks$,
  chooseRemoteSshConnection$,
  type RemoteSetupNetwork,
} from "../../signals/remote-control-setup.ts";
import { sshConnectionModeEditor$ } from "../../signals/ssh.ts";

interface ConnectionOption {
  readonly value: string;
  readonly label: string;
  readonly text: string;
  readonly mode: SshConnectionMode;
  readonly networkId: string;
}

function useNetworkGroups(networks: readonly RemoteSetupNetwork[]) {
  const { t } = useTranslation();
  const modes = [
    {
      mode: "tailscale",
      label: t(($) => {
        return $.tailscale.title;
      }),
    },
    {
      mode: "cloudflare_access",
      label: t(($) => {
        return $.ssh.cloudflare.title;
      }),
    },
    {
      mode: "tailscale_ssh",
      label: t(($) => {
        return $.ssh.tailscale.sshTitle;
      }),
    },
  ] as const;
  return modes.map(({ mode, label }) => {
    return {
      mode,
      label,
      items: networks
        .filter((network) => {
          return (
            network.route === (mode === "tailscale_ssh" ? "tailscale" : mode)
          );
        })
        .map((network): ConnectionOption => {
          return {
            value: `${mode}:${network.id}`,
            label: `${network.name} · ${label}`,
            text: network.name,
            mode,
            networkId: network.id,
          };
        }),
    };
  });
}

function NetworkOptions({
  direct,
  groups,
  isEmpty,
}: {
  readonly direct: ConnectionOption;
  readonly groups: ReturnType<typeof useNetworkGroups>;
  readonly isEmpty: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SelectContent align="start" className="w-(--anchor-width)">
      <SelectItem value={direct.value}>{direct.label}</SelectItem>
      {groups.map((group) => {
        if (group.items.length === 0) {
          return null;
        }
        return (
          <SelectGroup key={group.mode} className="gap-0 pt-2">
            <SelectLabel className="px-2 py-1 text-[13px] font-normal leading-5">
              {group.label}
            </SelectLabel>
            {group.items.map((item) => {
              return (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  aria-label={item.label}
                >
                  {item.text}
                </SelectItem>
              );
            })}
          </SelectGroup>
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
  const editor = useGet(sshConnectionModeEditor$);
  const choose = useSet(chooseRemoteSshConnection$);
  const available = networks.state === "hasData" ? networks.data : [];
  const isEmpty = networks.state === "hasData" && available.length === 0;
  const groups = useNetworkGroups(available);
  const direct: ConnectionOption = {
    value: "direct",
    label: t(($) => {
      return $.remoteControlSetup.direct;
    }),
    text: t(($) => {
      return $.remoteControlSetup.direct;
    }),
    mode: "direct",
    networkId: "",
  };
  const items = [
    direct,
    ...groups.flatMap((group) => {
      return group.items;
    }),
  ];
  const networkId =
    editor.mode === "cloudflare_access"
      ? editor.configId
      : editor.tailscaleConfigId;
  const selected =
    editor.mode === "direct" ? "direct" : `${editor.mode}:${networkId}`;
  const ready = items.some((item) => {
    return item.value === selected;
  });
  return (
    <div className="grid gap-2">
      <label htmlFor="remote-connection-network">
        {t(($) => {
          return $.remoteControlSetup.connectionMethod;
        })}
      </label>
      <Select
        items={items}
        value={ready ? selected : null}
        disabled={disabled}
        onValueChange={(value) => {
          const option = items.find((item) => {
            return item.value === value;
          });
          if (option) {
            choose(option.mode, option.networkId);
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
        <NetworkOptions direct={direct} groups={groups} isEmpty={isEmpty} />
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
