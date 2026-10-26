import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import {
  GuidedRemoteControlPanel,
  GuidedPrivateNetworkPanel,
} from "./remote-guided-directory.tsx";
import { useGet, useSet } from "ccstate-react";
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
import { SshCredentials, SshDialog, SshHosts } from "./ssh-management.tsx";
import { VncCredentials, VncHosts } from "./vnc-management.tsx";
import { VncDialog } from "./vnc-dialog.tsx";
import {
  CloudflareAccessConfigs,
  CloudflareAccessDialog,
  CloudflareAccessConversionDialog,
  CloudflareAccessDeletionDialog,
  CloudflareAccessPromotionDialog,
} from "./cloudflare-access.tsx";
import { TailscaleManagement } from "./tailscale-management.tsx";
import {
  mountPrivateNetworkPanel$,
  mountRemoteControlPanel$,
} from "../../signals/remote-management-realtime.ts";

function ConnectionTypeFilter() {
  const { t } = useTranslation();
  const selectedType = useGet(remoteControlType$);
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
  const options: readonly RemoteControlType[] = ["all", "ssh", "vnc"];
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

function LegacyRemoteControlPanel() {
  const { t } = useTranslation();
  const selectedType = useGet(remoteControlType$);
  const view = useGet(remoteControlView$);
  const setView = useSet(setRemoteControlView$);
  const mount = useSet(mountRemoteControlPanel$);
  const showSsh = selectedType === "all" || selectedType === "ssh";
  const showVnc = selectedType === "all" || selectedType === "vnc";
  return (
    <div ref={mount} className="grid gap-6">
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
        <ConnectionTypeFilter />
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
          </div>
          {view === "connections" ? <VncHosts /> : <VncCredentials />}
        </section>
      )}
      <SshDialog />
      <VncDialog />
    </div>
  );
}

function LegacyPrivateNetworkPanel() {
  const { t } = useTranslation();
  const mount = useSet(mountPrivateNetworkPanel$);
  return (
    <div ref={mount} className="grid gap-6">
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
        <CloudflareAccessDeletionDialog />
        <CloudflareAccessPromotionDialog />
      </section>
      <TailscaleManagement />
    </div>
  );
}

export function RemoteControlPanel() {
  const guided = useGet(remoteControlGuidedEnabled$);
  return guided ? <GuidedRemoteControlPanel /> : <LegacyRemoteControlPanel />;
}
export function PrivateNetworkPanel() {
  const guided = useGet(remoteControlGuidedEnabled$);
  return guided ? <GuidedPrivateNetworkPanel /> : <LegacyPrivateNetworkPanel />;
}
