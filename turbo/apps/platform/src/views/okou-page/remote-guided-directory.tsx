import { searchParams$ } from "../../signals/route.ts";
import { remoteResourceHref } from "../../signals/remote-resource-detail.ts";
import { privateNetworkHostCount } from "../../lib/private-network-references.ts";
import type { SshConnectionResponse } from "@okouai/api-contracts/contracts/ssh-connections";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";
import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Laptop,
  LockKeyhole,
  Network,
  Plus,
  Terminal,
  Monitor,
  ChevronRight,
} from "lucide-react";
import { Button, Card, LoadErrorRow } from "@okouai/ui";
import {
  enterRemoteSetup$,
  remoteSetup$,
  setRemoteNetworkPicker$,
} from "../../signals/remote-control-setup.ts";
import { sshConnections$ } from "../../signals/ssh.ts";
import { vncConnections$ } from "../../signals/vnc.ts";
import {
  tailscaleConfigs$,
  tailscaleSettingsEnabled$,
  retryTailscale$,
} from "../../signals/tailscale.ts";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { SshDialog } from "./ssh-management.tsx";
import { VncDialog } from "./vnc-dialog.tsx";
import { SshLastCheck } from "./ssh-connection-status.tsx";
import { VncLastCheck } from "./vnc-connection-status.tsx";
import { SshLoadError } from "./ssh-load-error.tsx";
import { VncLoadError } from "./vnc-load-error.tsx";
import { RemoteConnectionSetup } from "./remote-connection-setup.tsx";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";
import { TailscaleDialog } from "./tailscale-management.tsx";
import {
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
  const params = useGet(searchParams$);
  return (
    <div className="overflow-hidden rounded-3xl border-divider bg-card has-[a]:border divide-y divide-divider">
      {sshRows?.map((connection) => {
        return (
          <a
            key={connection.id}
            href={remoteResourceHref(params, "ssh", connection.id)}
            className="block"
          >
            <div className="flex items-center gap-3 p-4 hover:bg-gray-50 sm:p-5">
              <span className="rounded-lg bg-gray-50 p-2">
                <Terminal size={20} aria-hidden />
              </span>
              <span className="grid min-w-0 flex-1 gap-1">
                <strong className="truncate text-sm">
                  {connection.displayName}
                </strong>
                <span className="break-all text-xs text-muted-foreground">
                  {t(($) => {
                    return $.ssh.label;
                  })}{" "}
                  · {connection.username}@{connection.host}:{connection.port} ·{" "}
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
                className="shrink-0 text-muted-foreground"
              />
            </div>
          </a>
        );
      })}
      {vncRows?.map((connection) => {
        return (
          <a
            key={connection.id}
            href={remoteResourceHref(params, "vnc", connection.id)}
            className="block"
          >
            <div className="flex items-center gap-3 p-4 hover:bg-gray-50 sm:p-5">
              <span className="rounded-lg bg-gray-50 p-2">
                <Monitor size={20} aria-hidden />
              </span>
              <span className="grid min-w-0 flex-1 gap-1">
                <strong className="truncate text-sm">
                  {connection.displayName}
                </strong>
                <span className="break-all text-xs text-muted-foreground">
                  {t(($) => {
                    return $.vnc.label;
                  })}{" "}
                  · {connection.host}:{connection.port} ·{" "}
                  {connection.transport?.type === "ssh"
                    ? `${t(($) => {
                        return $.ssh.label;
                      })} · ${
                        sshRows?.find((host) => {
                          return (
                            connection.transport?.type === "ssh" &&
                            host.id === connection.transport.connectionId
                          );
                        })?.displayName ?? connection.transport.connectionId
                      }`
                    : connection.transport?.type === "tailscale"
                      ? t(($) => {
                          return $.tailscale.title;
                        })
                      : connection.transport?.type === "cloudflare_access"
                        ? t(($) => {
                            return $.cloudflareAccess.title;
                          })
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
                className="shrink-0 text-muted-foreground"
              />
            </div>
          </a>
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
    if (type === "direct") {
      return t(($) => {
        return $.remoteControlSetup.direct;
      });
    }
    const configs = type === "cloudflare_access" ? access : tailscale;
    const name =
      configs.state === "hasData"
        ? configs.data?.find((config) => {
            return config.id === id;
          })?.name
        : null;
    return (
      name ??
      (type === "cloudflare_access"
        ? t(($) => {
            return $.cloudflareAccess.title;
          })
        : t(($) => {
            return $.tailscale.title;
          }))
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
          className="grid justify-items-center gap-4 px-6 py-8 text-center"
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
  const start = useSet(enterRemoteSetup$);
  if (setup) {
    return <RemoteConnectionSetup vncEnabled={vncEnabled} />;
  }
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="grid gap-1">
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
      <RemoteConnectionList vncEnabled={vncEnabled} />
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <LockKeyhole size={14} aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.entryPermission;
        })}
      </p>
      <SshDialog />
      {vncEnabled && <VncDialog />}
      <TailscaleDialog />
      <CloudflareAccessDialog />
    </div>
  );
}
function PrivateNetworkRows({
  ts,
  cf,
}: {
  readonly ts: readonly TailscaleConfig[] | null;
  readonly cf: readonly ScopedCloudflareAccessConfig[] | null;
}) {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const rows = [
    ...(ts ?? []).map((config) => {
      return {
        config,
        kind: "tailscale" as const,
        label: t(($) => {
          return $.tailscale.title;
        }),
      };
    }),
    ...(cf ?? []).map((config) => {
      return {
        config,
        kind: "cloudflare" as const,
        label: t(($) => {
          return $.cloudflareAccess.title;
        }),
      };
    }),
  ];
  return (
    <div className="overflow-hidden rounded-3xl border-divider bg-card divide-y divide-divider has-[a]:border">
      {rows.map(({ config, kind, label }) => {
        return (
          <a
            key={config.id}
            href={remoteResourceHref(params, kind, config.id)}
            className="flex items-center gap-3 p-4 hover:bg-gray-50 sm:p-5"
          >
            <span className="rounded-lg bg-gray-50 p-2">
              <Network size={20} aria-hidden />
            </span>
            <span className="grid min-w-0 flex-1 gap-1">
              <strong className="truncate text-sm font-medium">
                {config.name}
              </strong>
              <span className="text-xs text-muted-foreground">
                {label} ·{" "}
                {t(($) => {
                  return config.scope === "personal"
                    ? $.cloudflareAccess.personal
                    : $.cloudflareAccess.organization;
                })}
              </span>
            </span>
            <span className="text-right text-xs text-muted-foreground">
              {t(
                ($) => {
                  return $.cloudflareAccess.usedBy;
                },
                { count: privateNetworkHostCount(config) },
              )}
            </span>
            <ChevronRight
              size={16}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
          </a>
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
  const open = useSet(setRemoteNetworkPicker$);
  const retry = useSet(retryTailscale$);
  const signal = useGet(pageSignal$);
  const ts =
    tailscaleEnabled && tailscale.state === "hasData" ? tailscale.data : null;
  const cf = access.state === "hasData" ? access.data : null;
  const empty = cf?.length === 0 && (!tailscaleEnabled || ts?.length === 0);
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="grid gap-1">
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
        {!empty && (
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
        )}
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
          className="grid justify-items-center gap-4 px-6 py-8 text-center"
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
      <PrivateNetworkRows ts={ts} cf={cf} />
      <TailscaleDialog />
      <CloudflareAccessDialog />
      <CloudflareAccessConversionDialog />
      <CloudflareAccessDeletionDialog />
      <CloudflareAccessPromotionDialog />
    </div>
  );
}
