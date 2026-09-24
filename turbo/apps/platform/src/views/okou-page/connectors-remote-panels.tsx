import { useGet, useSet } from "ccstate-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Filter } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui";
import {
  remoteControlType$,
  remoteControlView$,
  setRemoteControlType$,
  setRemoteControlView$,
  type RemoteControlType,
} from "../../signals/okou-page/settings/remote-control-directory.ts";
import { openSshAccessManagement$ } from "../../signals/ssh.ts";
import { openVncAccessManagement$ } from "../../signals/vnc-access.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { SshCredentials, SshDialog, SshHosts } from "./ssh-management.tsx";
import { VncCredentials, VncHosts } from "./vnc-management.tsx";
import { VncDialog } from "./vnc-dialog.tsx";
import {
  CloudflareAccessConfigs,
  CloudflareAccessDialog,
  CloudflareAccessConversionDialog,
} from "./cloudflare-access.tsx";

function ConnectionTypeFilter({
  vncEnabled,
}: {
  readonly vncEnabled: boolean;
}) {
  const { t } = useTranslation();
  const type = useGet(remoteControlType$);
  const selectedType = type === "vnc" && !vncEnabled ? "all" : type;
  const setType = useSet(setRemoteControlType$);
  const label =
    selectedType === "ssh"
      ? t(($) => {
          return $.ssh.label;
        })
      : selectedType === "vnc"
        ? t(($) => {
            return $.vnc.label;
          })
        : t(($) => {
            return $.connectors.catalog.filters.all;
          });
  const options: readonly RemoteControlType[] = vncEnabled
    ? ["all", "ssh", "vnc"]
    : ["all", "ssh"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="gap-1.5" />}
      >
        <Filter size={14} aria-hidden="true" />
        {t(($) => {
          return $.connectors.catalog.remoteControl.type;
        })}
        {": "}
        {label}
        <ChevronDown size={14} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {options.map((option) => {
          const optionLabel =
            option === "ssh"
              ? t(($) => {
                  return $.ssh.label;
                })
              : option === "vnc"
                ? t(($) => {
                    return $.vnc.label;
                  })
                : t(($) => {
                    return $.connectors.catalog.filters.all;
                  });
          return (
            <DropdownMenuItem
              key={option}
              onClick={() => {
                setType(option);
              }}
              className="justify-between"
            >
              {optionLabel}
              {selectedType === option && (
                <Check size={14} aria-hidden="true" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RemoteControlPanel({
  vncEnabled,
}: {
  readonly vncEnabled: boolean;
}) {
  const { t } = useTranslation();
  const threadRemoteAccess =
    useGet(featureSwitch$)[FeatureSwitchKey.ThreadRemoteAccess] === true;
  const type = useGet(remoteControlType$);
  const selectedType = type === "vnc" && !vncEnabled ? "all" : type;
  const view = useGet(remoteControlView$);
  const setView = useSet(setRemoteControlView$);
  const openSshAccess = useSet(openSshAccessManagement$);
  const openVncAccess = useSet(openVncAccessManagement$);
  const signal = useGet(pageSignal$);
  const showSsh = selectedType === "all" || selectedType === "ssh";
  const showVnc =
    vncEnabled && (selectedType === "all" || selectedType === "vnc");
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentControl
          value={view}
          onValueChange={(value) => {
            setView(value === "credentials" ? "credentials" : "connections");
          }}
          aria-label={t(($) => {
            return $.connectors.catalog.scope.remoteControl;
          })}
        >
          <SegmentControlItem value="connections">
            {t(($) => {
              return $.connectors.catalog.remoteControl.connections;
            })}
          </SegmentControlItem>
          <SegmentControlItem value="credentials">
            {t(($) => {
              return $.connectors.catalog.remoteControl.credentials;
            })}
          </SegmentControlItem>
        </SegmentControl>
        <ConnectionTypeFilter vncEnabled={vncEnabled} />
      </div>
      {showSsh && (
        <section
          aria-label={t(($) => {
            return $.ssh.label;
          })}
          className="grid gap-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">
              {t(($) => {
                return $.ssh.label;
              })}
            </h2>
            {view === "connections" && !threadRemoteAccess && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  return detach(openSshAccess(signal), Reason.DomCallback);
                }}
              >
                {t(
                  ($) => {
                    return $.connectors.access.title;
                  },
                  { connector: "SSH" },
                )}
              </Button>
            )}
          </div>
          {view === "connections" ? <SshHosts /> : <SshCredentials />}
        </section>
      )}
      {showVnc && (
        <section
          aria-label={t(($) => {
            return $.vnc.label;
          })}
          className="grid gap-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">
              {t(($) => {
                return $.vnc.label;
              })}
            </h2>
            {view === "connections" && !threadRemoteAccess && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  return detach(openVncAccess(signal), Reason.DomCallback);
                }}
              >
                {t(
                  ($) => {
                    return $.connectors.access.title;
                  },
                  { connector: "VNC" },
                )}
              </Button>
            )}
          </div>
          {view === "connections" ? <VncHosts /> : <VncCredentials />}
        </section>
      )}
      <SshDialog />
      {vncEnabled && <VncDialog />}
    </div>
  );
}

export function PrivateNetworkPanel() {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(($) => {
        return $.cloudflareAccess.title;
      })}
      className="grid gap-4"
    >
      <h2 className="text-sm font-medium">
        {t(($) => {
          return $.cloudflareAccess.title;
        })}
      </h2>
      <CloudflareAccessConfigs />
      <CloudflareAccessDialog />
      <CloudflareAccessConversionDialog />
    </section>
  );
}
