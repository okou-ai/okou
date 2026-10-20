import { isOrgAdmin$ } from "../../signals/org.ts";
import type { ReactNode } from "react";
import { searchParams$, updateSearchParams$ } from "../../signals/route.ts";
import {
  remoteResourceSearchParams,
  remoteNetworkConnections$,
  closeRemoteNetworkConnections$,
} from "../../signals/remote-resource-detail.ts";
import { privateNetworkHostCount } from "../../lib/private-network-references.ts";
import type { SshConnectionResponse } from "@okouai/api-contracts/contracts/ssh-connections";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";
import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  LockKeyhole,
  Network,
  Cloud,
  Plus,
  Terminal,
  Monitor,
  ChevronRight,
} from "lucide-react";
import {
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  LoadErrorRow,
} from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui/lib/utils";
import { Link } from "../router/link.tsx";
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
import { SshLoadError } from "./ssh-load-error.tsx";
import { VncLoadError } from "./vnc-load-error.tsx";
import { RemoteConnectionSetup } from "./remote-connection-setup.tsx";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";
import { RemoteNetworkConnections } from "./remote-network-summary.tsx";
import { TailscaleDialog } from "./tailscale-management.tsx";
import {
  CloudflareAccessDialog,
  CloudflareAccessLoadError,
  CloudflareAccessConversionDialog,
  CloudflareAccessDeletionDialog,
  CloudflareAccessPromotionDialog,
} from "./cloudflare-access.tsx";

function RemoteDirectoryGroup({
  title,
  description,
  empty,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly empty: boolean;
  readonly children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={title}>
      <Card className="overflow-hidden rounded-3xl border-divider">
        <header
          className={cn(
            "flex items-center justify-between gap-4 px-4 py-4 sm:px-5",
            !empty && "border-b border-divider bg-gray-50",
          )}
        >
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          {empty && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t(($) => {
                return $.remoteNetworkScope.notAdded;
              })}
            </span>
          )}
        </header>
        {!empty && children}
      </Card>
    </section>
  );
}

function RemoteVncConnectionRow({
  connection,
  sshRows,
}: {
  readonly connection: VncConnectionResponse;
  readonly sshRows: readonly SshConnectionResponse[] | null;
}) {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  return (
    <Link
      pathname="/connectors"
      options={{
        searchParams: remoteResourceSearchParams(params, "vnc", connection.id),
      }}
      className="block"
    >
      <div className="flex items-center gap-3 p-4 hover:bg-gray-50 sm:p-5">
        <span className="shrink-0 rounded-lg bg-gray-50 p-2">
          <Monitor size={20} aria-hidden />
        </span>
        <span className="grid min-w-0 flex-1 gap-1">
          <strong className="truncate text-sm">{connection.displayName}</strong>
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
        <span className={buttonVariants({ variant: "outline", size: "sm" })}>
          {t(($) => {
            return $.remoteNetworkScope.manage;
          })}
        </span>
      </div>
    </Link>
  );
}

function RemoteConnectionRows({
  sshRows,
  vncRows,
  networkLabel,
  empty,
}: {
  readonly sshRows: readonly SshConnectionResponse[] | null;
  readonly vncRows: readonly VncConnectionResponse[] | null;
  readonly networkLabel: (type: string, id: string | undefined) => string;
  readonly empty: boolean;
}) {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  if (!empty && !sshRows?.length && !vncRows?.length) {
    return null;
  }
  return (
    <RemoteDirectoryGroup
      title={t(($) => {
        return $.remoteControlSetup.personalConnections;
      })}
      description={t(($) => {
        return $.remoteNetworkScope.personalGroupHelp;
      })}
      empty={empty}
    >
      <ul className="divide-y divide-divider">
        {sshRows?.map((connection) => {
          return (
            <li key={connection.id}>
              <Link
                pathname="/connectors"
                options={{
                  searchParams: remoteResourceSearchParams(
                    params,
                    "ssh",
                    connection.id,
                  ),
                }}
                className="block"
              >
                <div className="flex items-center gap-3 p-4 hover:bg-gray-50 sm:p-5">
                  <span className="shrink-0 rounded-lg bg-gray-50 p-2">
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
                      · {connection.username}@{connection.host}:
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
                  <span
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                  >
                    {t(($) => {
                      return $.remoteNetworkScope.manage;
                    })}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
        {vncRows?.map((connection) => {
          return (
            <li key={connection.id}>
              <RemoteVncConnectionRow
                connection={connection}
                sshRows={sshRows}
              />
            </li>
          );
        })}
      </ul>
    </RemoteDirectoryGroup>
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
      <RemoteConnectionRows
        sshRows={sshRows}
        vncRows={vncRows}
        networkLabel={networkLabel}
        empty={empty}
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
function PrivateNetworkGroupRows({
  ts,
  cf,
}: {
  readonly ts: readonly TailscaleConfig[] | null;
  readonly cf: readonly ScopedCloudflareAccessConfig[] | null;
}) {
  const { t } = useTranslation();
  const admin = useLoadable(isOrgAdmin$);
  const params = useGet(searchParams$);
  const updateParams = useSet(updateSearchParams$);
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
    <ul className="divide-y divide-divider">
      {rows.map(({ config, kind, label }) => {
        const detailParams = remoteResourceSearchParams(
          params,
          kind,
          config.id,
        );
        const connectionParams = new URLSearchParams(detailParams);
        connectionParams.delete("remoteResource");
        connectionParams.set("networkConnections", `${kind}:${config.id}`);
        const canManage =
          config.scope === "personal" ||
          (admin.state === "hasData" && admin.data);
        const action = t(($) => {
          return canManage
            ? $.remoteNetworkScope.manage
            : $.remoteNetworkScope.view;
        });
        const countLabel = t(
          ($) => {
            return $.remoteNetworkScope.connectionCount;
          },
          { count: privateNetworkHostCount(config) },
        );
        return (
          <li
            key={`${kind}:${config.id}`}
            className="flex items-center gap-3 p-4 sm:p-5"
          >
            <span className="shrink-0 rounded-lg bg-gray-50 p-2">
              {kind === "cloudflare" ? (
                <Cloud size={20} aria-hidden />
              ) : (
                <Network size={20} aria-hidden />
              )}
            </span>
            <div className="grid min-w-0 flex-1 gap-1">
              <Link
                pathname="/connectors"
                options={{ searchParams: detailParams }}
                className="truncate text-sm font-semibold hover:underline"
                title={config.name}
              >
                {config.name}
              </Link>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                <span>{label}</span>
                <span aria-hidden>·</span>
                <Button
                  variant="link"
                  onClick={() => {
                    updateParams(connectionParams);
                  }}
                  aria-label={`${config.name} · ${countLabel}`}
                  className="h-auto p-0 text-xs font-normal text-muted-foreground gap-1 hover:text-foreground"
                >
                  {countLabel}
                  <ChevronRight size={14} aria-hidden />
                </Button>
              </div>
            </div>
            <Link
              pathname="/connectors"
              options={{ searchParams: detailParams }}
              aria-label={`${action} ${config.name}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {action}
            </Link>
          </li>
        );
      })}
    </ul>
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
  const admin = useLoadable(isOrgAdmin$);
  return (
    <div className="grid gap-5">
      {(["personal", "organization"] as const).map((scope) => {
        const tailscale =
          ts?.filter((config) => {
            return config.scope === scope;
          }) ?? [];
        const cloudflare =
          cf?.filter((config) => {
            return config.scope === scope;
          }) ?? [];
        const count = tailscale.length + cloudflare.length;
        if (count === 0 && (ts === null || cf === null)) {
          return null;
        }
        return (
          <RemoteDirectoryGroup
            key={scope}
            title={t(($) => {
              return scope === "personal"
                ? $.remoteNetworkScope.personalGroup
                : $.remoteNetworkScope.organizationGroup;
            })}
            description={t(($) => {
              return scope === "personal"
                ? $.remoteNetworkScope.personalGroupHelp
                : admin.state === "hasData" && admin.data
                  ? $.remoteNetworkScope.organizationGroupHelp
                  : $.remoteNetworkScope.organizationMemberHelp;
            })}
            empty={count === 0}
          >
            <PrivateNetworkGroupRows ts={tailscale} cf={cloudflare} />
          </RemoteDirectoryGroup>
        );
      })}
    </div>
  );
}

function PrivateNetworkConnectionsDialog({
  ts,
  cf,
}: {
  readonly ts: readonly TailscaleConfig[] | null;
  readonly cf: readonly ScopedCloudflareAccessConfig[] | null;
}) {
  const { t } = useTranslation();
  const selection = useGet(remoteNetworkConnections$);
  const close = useSet(closeRemoteNetworkConnections$);
  const config = (selection?.kind === "tailscale" ? ts : cf)?.find((item) => {
    return item.id === selection?.id;
  });
  if (!config) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.remoteControlSetup.linkedConnections;
            })}
          </DialogTitle>
          <DialogDescription className="break-words">
            {config.name}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <RemoteNetworkConnections config={config} showHeading={false} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function GuidedPrivateNetworkPanel() {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const connectionsParams = new URLSearchParams(params);
  connectionsParams.set("scope", "remote-control");
  connectionsParams.delete("remoteResource");
  connectionsParams.delete("networkConnections");
  connectionsParams.delete("setup");
  const tailscale = useLoadable(tailscaleConfigs$);
  const access = useLoadable(cloudflareAccessConfigs$);
  const tailscaleEnabled = useGet(tailscaleSettingsEnabled$);
  const open = useSet(setRemoteNetworkPicker$);
  const retry = useSet(retryTailscale$);
  const signal = useGet(pageSignal$);
  const ts = !tailscaleEnabled
    ? []
    : tailscale.state === "hasData"
      ? tailscale.data
      : null;
  const cf = access.state === "hasData" ? access.data : null;
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">
            {t(($) => {
              return $.remoteControlSetup.networkTitle;
            })}
          </h2>
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
      <PrivateNetworkRows ts={ts} cf={cf} />
      <PrivateNetworkConnectionsDialog ts={ts} cf={cf} />
      <Link
        pathname="/connectors"
        options={{ searchParams: connectionsParams }}
        className={cn(
          buttonVariants({ variant: "quiet", size: "sm" }),
          "justify-self-start text-muted-foreground",
        )}
      >
        <Monitor size={16} aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.manageConnections;
        })}
      </Link>
      <TailscaleDialog />
      <CloudflareAccessDialog />
      <CloudflareAccessConversionDialog />
      <CloudflareAccessDeletionDialog />
      <CloudflareAccessPromotionDialog />
    </div>
  );
}
