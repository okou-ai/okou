import type { SshConnectionResponse } from "@okouai/api-contracts/contracts/ssh-connections";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";
import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { NetworkProviderPicker } from "./remote-network-picker.tsx";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Laptop,
  Network,
  Plus,
  Terminal,
  Monitor,
  ChevronRight,
} from "lucide-react";
import {
  Button,
  Card,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  LoadErrorRow,
} from "@okouai/ui";
import {
  enterRemoteSetup$,
  remoteSetup$,
  setRemoteNetworkPicker$,
} from "../../signals/remote-control-setup.ts";
import {
  remoteControlView$,
  setRemoteControlView$,
} from "../../signals/okou-page/settings/remote-control-directory.ts";
import { sshConnections$ } from "../../signals/ssh.ts";
import { vncConnections$ } from "../../signals/vnc.ts";
import {
  tailscaleConfigs$,
  tailscaleSettingsEnabled$,
  retryTailscale$,
} from "../../signals/tailscale.ts";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { SshCredentials, SshDialog, SshHostCard } from "./ssh-management.tsx";
import { VncCredentials, VncHostCard } from "./vnc-management.tsx";
import { VncDialog } from "./vnc-dialog.tsx";
import { SshLastCheck } from "./ssh-connection-status.tsx";
import { VncLastCheck } from "./vnc-connection-status.tsx";
import { SshLoadError } from "./ssh-load-error.tsx";
import { VncLoadError } from "./vnc-load-error.tsx";
import { RemoteConnectionSetup } from "./remote-connection-setup.tsx";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";
import { TailscaleDialog, TailscaleSection } from "./tailscale-management.tsx";
import {
  CloudflareAccessSection,
  CloudflareAccessDialog,
  CloudflareAccessLoadError,
  CloudflareAccessConversionDialog,
  CloudflareAccessDeletionDialog,
  CloudflareAccessPromotionDialog,
} from "./cloudflare-access.tsx";

function RemoteConnectionRows({
  sshRows,
  vncRows,
  networkLabel,
}: {
  readonly sshRows: readonly SshConnectionResponse[] | null;
  readonly vncRows: readonly VncConnectionResponse[] | null;
  readonly networkLabel: (type: string, id: string | undefined) => string;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-3xl border-divider bg-card has-[details]:border divide-y divide-divider">
      {sshRows?.map((connection) => {
        return (
          <details key={connection.id} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-4 p-5 hover:bg-gray-50">
              <span className="rounded-lg bg-gray-50 p-3">
                <Terminal size={20} aria-hidden />
              </span>
              <span className="grid min-w-0 flex-1 gap-1">
                <strong className="truncate text-sm">
                  {connection.displayName}
                </strong>
                <span className="break-all text-xs text-muted-foreground">
                  SSH · {connection.username}@{connection.host}:
                  {connection.port} ·{" "}
                  {"transport" in connection
                    ? networkLabel(
                        connection.transport.type,
                        "configId" in connection.transport
                          ? connection.transport.configId
                          : undefined,
                      )
                    : t(($) => {
                        return $.remoteControlSetup.direct;
                      })}
                </span>
              </span>
              <SshLastCheck
                connectionId={connection.id}
                generation={connection.generation}
                createdAt={connection.createdAt}
              />
              <ChevronRight
                size={18}
                aria-hidden
                className="text-muted-foreground group-open:rotate-90"
              />
            </summary>
            <div className="border-t border-divider p-4">
              <SshHostCard connection={connection} />
            </div>
          </details>
        );
      })}
      {vncRows?.map((connection) => {
        return (
          <details key={connection.id} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-4 p-5 hover:bg-gray-50">
              <span className="rounded-lg bg-gray-50 p-3">
                <Monitor size={20} aria-hidden />
              </span>
              <span className="grid min-w-0 flex-1 gap-1">
                <strong className="truncate text-sm">
                  {connection.displayName}
                </strong>
                <span className="break-all text-xs text-muted-foreground">
                  VNC · {connection.host}:{connection.port} ·{" "}
                  {connection.transport?.type === "ssh"
                    ? `SSH · ${
                        sshRows?.find((host) => {
                          return (
                            connection.transport?.type === "ssh" &&
                            host.id === connection.transport.connectionId
                          );
                        })?.displayName ?? connection.transport.connectionId
                      }`
                    : connection.transport?.type === "tailscale"
                      ? "Tailscale"
                      : connection.transport?.type === "cloudflare_access"
                        ? "Cloudflare Access"
                        : t(($) => {
                            return $.remoteControlSetup.direct;
                          })}
                </span>
              </span>
              <VncLastCheck
                connectionId={connection.id}
                generation={connection.generation}
                createdAt={connection.createdAt}
              />
              <ChevronRight
                size={18}
                aria-hidden
                className="text-muted-foreground group-open:rotate-90"
              />
            </summary>
            <div className="border-t border-divider p-4">
              <VncHostCard connection={connection} />
            </div>
          </details>
        );
      })}
    </div>
  );
}
function RemoteConnectionList({
  vncEnabled,
}: {
  readonly vncEnabled: boolean;
}) {
  const { t } = useTranslation();
  const ssh = useLoadable(sshConnections$);
  const vnc = useLoadable(vncConnections$);
  const tailscale = useLoadable(tailscaleConfigs$);
  const access = useLoadable(cloudflareAccessConfigs$);
  const start = useSet(enterRemoteSetup$);
  const sshRows = ssh.state === "hasData" ? ssh.data : null;
  const vncRows = vncEnabled && vnc.state === "hasData" ? vnc.data : null;
  const loading =
    ssh.state === "loading" || (vncEnabled && vnc.state === "loading");
  const empty = sshRows?.length === 0 && (!vncEnabled || vncRows?.length === 0);
  const networkLabel = (type: string, id: string | undefined) => {
    const configs = type === "cloudflare_access" ? access : tailscale;
    const name =
      configs.state === "hasData"
        ? configs.data?.find((config) => {
            return config.id === id;
          })?.name
        : null;
    return (
      name ?? (type === "cloudflare_access" ? "Cloudflare Access" : "Tailscale")
    );
  };
  return (
    <div className="grid gap-3">
      {loading && (
        <p role="status">
          {t(($) => {
            return $.remoteControlSetup.loading;
          })}
        </p>
      )}
      {ssh.state === "hasError" && <SshLoadError />}
      {vncEnabled && vnc.state === "hasError" && <VncLoadError />}
      {ssh.state === "hasData" && !ssh.data && (
        <p>
          {t(($) => {
            return $.ssh.unavailable;
          })}
        </p>
      )}
      {vncEnabled && vnc.state === "hasData" && !vnc.data && (
        <p>
          {t(($) => {
            return $.vnc.unavailable;
          })}
        </p>
      )}
      {empty && (
        <Card
          surface="composer"
          className="grid justify-items-center gap-4 p-8 text-center"
        >
          <span className="rounded-xl bg-gray-50 p-3">
            <Laptop size={24} aria-hidden />
          </span>
          <h3 className="font-semibold">
            {t(($) => {
              return $.remoteControlSetup.empty;
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.emptyHelp;
            })}
          </p>
          <Button
            className={REMOTE_PAGE_ACTION}
            onClick={() => {
              start();
            }}
          >
            <Plus size={16} aria-hidden />
            {t(($) => {
              return $.remoteControlSetup.first;
            })}
          </Button>
        </Card>
      )}
      <RemoteConnectionRows
        sshRows={sshRows}
        vncRows={vncRows}
        networkLabel={networkLabel}
      />
    </div>
  );
}
export function GuidedRemoteControlPanel({
  vncEnabled,
}: {
  readonly vncEnabled: boolean;
}) {
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  const view = useGet(remoteControlView$);
  const setView = useSet(setRemoteControlView$);
  const start = useSet(enterRemoteSetup$);
  if (setup) {
    return <RemoteConnectionSetup vncEnabled={vncEnabled} />;
  }
  return (
    <div className="grid gap-6">
      <header className="flex items-center justify-between gap-4">
        <div className="grid gap-2">
          <h2 className="text-lg font-semibold">
            {t(($) => {
              return $.remoteControlSetup.title;
            })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.description;
            })}
          </p>
        </div>
        <Button
          className={REMOTE_PAGE_ACTION}
          onClick={() => {
            start();
          }}
        >
          <Plus size={16} aria-hidden />
          {t(($) => {
            return $.remoteControlSetup.add;
          })}
        </Button>
      </header>
      <Tabs
        value={view}
        onValueChange={(value) => {
          setView(value === "credentials" ? "credentials" : "connections");
        }}
        className="grid gap-6"
      >
        <TabsList className="h-10 justify-start rounded-none border-b border-divider bg-transparent p-0">
          <TabsTrigger
            value="connections"
            className="rounded-none border-b-2 border-transparent px-0 mr-6 data-active:border-foreground data-active:bg-transparent data-active:shadow-none"
          >
            {t(($) => {
              return $.remoteControlSetup.connections;
            })}
          </TabsTrigger>
          <TabsTrigger
            value="credentials"
            className="rounded-none border-b-2 border-transparent px-0 data-active:border-foreground data-active:bg-transparent data-active:shadow-none"
          >
            {t(($) => {
              return $.remoteControlSetup.credentials;
            })}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="connections">
          <RemoteConnectionList vncEnabled={vncEnabled} />
        </TabsContent>
        <TabsContent value="credentials" className="grid gap-6">
          <SshCredentials />
          {vncEnabled && <VncCredentials />}
        </TabsContent>
      </Tabs>
      <SshDialog />
      {vncEnabled && <VncDialog />}
      <NetworkProviderPicker />
      <TailscaleDialog />
      <CloudflareAccessDialog />
    </div>
  );
}
function PrivateNetworkRows({
  ts,
  cf,
  canManageOrg,
}: {
  readonly ts: readonly TailscaleConfig[] | null;
  readonly cf: readonly ScopedCloudflareAccessConfig[] | null;
  readonly canManageOrg: boolean;
}) {
  return (
    <div className="grid gap-3">
      {ts?.map((config) => {
        return (
          <details
            key={config.id}
            className="rounded-2xl border border-divider bg-card"
          >
            <summary className="flex cursor-pointer items-center gap-4 rounded-2xl p-5 hover:bg-gray-50">
              <Network size={20} aria-hidden />
              <span className="grid gap-1">
                <strong className="text-sm">{config.name}</strong>
                <span className="text-xs text-muted-foreground">
                  Tailscale · {config.tags.join(", ")}
                </span>
              </span>
            </summary>
            <div className="border-t border-divider p-4">
              <TailscaleSection
                compact
                scope={config.scope}
                configs={[config]}
                admin={canManageOrg}
              />
            </div>
          </details>
        );
      })}
      {cf?.map((config) => {
        return (
          <details
            key={config.id}
            className="rounded-2xl border border-divider bg-card"
          >
            <summary className="flex cursor-pointer items-center gap-4 rounded-2xl p-5 hover:bg-gray-50">
              <Network size={20} aria-hidden />
              <span className="grid gap-1">
                <strong className="text-sm">{config.name}</strong>
                <span className="text-xs text-muted-foreground">
                  Cloudflare Access
                </span>
              </span>
            </summary>
            <div className="border-t border-divider p-4">
              <CloudflareAccessSection
                compact
                scope={config.scope}
                configs={[config]}
                canManage={config.scope === "personal" || canManageOrg}
                canPromote={canManageOrg}
              />
            </div>
          </details>
        );
      })}
    </div>
  );
}
export function GuidedPrivateNetworkPanel() {
  const { t } = useTranslation();
  const tailscale = useLoadable(tailscaleConfigs$);
  const access = useLoadable(cloudflareAccessConfigs$);
  const tailscaleEnabled = useGet(tailscaleSettingsEnabled$);
  const admin = useLoadable(isOrgAdmin$);
  const open = useSet(setRemoteNetworkPicker$);
  const retry = useSet(retryTailscale$);
  const signal = useGet(pageSignal$);
  const canManageOrg = admin.state === "hasData" && admin.data;
  const ts =
    tailscaleEnabled && tailscale.state === "hasData" ? tailscale.data : null;
  const cf = access.state === "hasData" ? access.data : null;
  const empty = cf?.length === 0 && (!tailscaleEnabled || ts?.length === 0);
  return (
    <div className="grid gap-6">
      <header className="flex items-center justify-between gap-4">
        <div className="grid gap-2">
          <h2 className="text-lg font-semibold">
            {t(($) => {
              return $.remoteControlSetup.networkTitle;
            })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.networkDescription;
            })}
          </p>
        </div>
        <Button
          className={REMOTE_PAGE_ACTION}
          onClick={() => {
            open(true);
          }}
        >
          <Plus size={16} aria-hidden />
          {t(($) => {
            return $.remoteControlSetup.addNetwork;
          })}
        </Button>
      </header>
      {(access.state === "loading" ||
        (tailscaleEnabled && tailscale.state === "loading")) && (
        <p role="status">
          {t(($) => {
            return $.remoteControlSetup.loading;
          })}
        </p>
      )}
      {access.state === "hasError" && <CloudflareAccessLoadError />}
      {tailscaleEnabled && tailscale.state === "hasError" && (
        <LoadErrorRow
          message={t(($) => {
            return $.tailscale.loadFailed;
          })}
          retryLabel={t(($) => {
            return $.remoteControlSetup.retry;
          })}
          onRetry={() => {
            return retry(signal);
          }}
        />
      )}
      {empty && (
        <Card
          surface="composer"
          className="grid justify-items-center gap-4 p-8 text-center"
        >
          <span className="rounded-xl bg-gray-50 p-3">
            <Network size={24} aria-hidden />
          </span>
          <h3 className="font-semibold">
            {t(($) => {
              return $.remoteControlSetup.networkEmpty;
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.networkEmptyHelp;
            })}
          </p>
          <Button
            className={REMOTE_PAGE_ACTION}
            onClick={() => {
              open(true);
            }}
          >
            {t(($) => {
              return $.remoteControlSetup.addNetwork;
            })}
          </Button>
        </Card>
      )}
      <PrivateNetworkRows ts={ts} cf={cf} canManageOrg={canManageOrg} />
      <NetworkProviderPicker />
      <TailscaleDialog />
      <CloudflareAccessDialog />
      <CloudflareAccessConversionDialog />
      <CloudflareAccessDeletionDialog />
      <CloudflareAccessPromotionDialog />
    </div>
  );
}
