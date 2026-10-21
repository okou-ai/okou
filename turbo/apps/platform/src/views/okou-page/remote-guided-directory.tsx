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
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Laptop,
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
import { Link } from "../router/link.tsx";
import {
  enterRemoteSetup$,
  remoteSetup$,
  setRemoteNetworkPicker$,
} from "../../signals/remote-control-setup.ts";
import { sshConnections$, sshIdentity$ } from "../../signals/ssh.ts";
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
import { RemoteHostDefaultToggle } from "./remote-access-controls.tsx";
import { TailscaleDialog } from "./tailscale-management.tsx";
import {
  CloudflareAccessDialog,
  CloudflareAccessLoadError,
  CloudflareAccessConversionDialog,
  CloudflareAccessDeletionDialog,
  CloudflareAccessPromotionDialog,
} from "./cloudflare-access.tsx";

function PrivateNetworkGroup({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <Card className="overflow-hidden rounded-3xl border-divider">
        <header className="border-b border-divider bg-gray-50 px-4 py-4 sm:px-5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </header>
        {children}
      </Card>
    </section>
  );
}

function RemoteConnectionRow({
  connection,
  protocol,
  children,
}: {
  readonly connection: { readonly id: string; readonly displayName: string };
  readonly protocol: "ssh" | "vnc";
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const options = {
    searchParams: remoteResourceSearchParams(params, protocol, connection.id),
  };
  return (
    <li
      aria-label={connection.displayName}
      className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-5"
    >
      <Link
        pathname="/connectors"
        options={options}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="shrink-0 rounded-lg bg-gray-50 p-2">
          {protocol === "ssh" ? (
            <Terminal size={20} aria-hidden />
          ) : (
            <Monitor size={20} aria-hidden />
          )}
        </span>
        <span className="grid min-w-0 flex-1 gap-1">
          <strong className="truncate text-sm">{connection.displayName}</strong>
          <span className="break-all text-sm text-muted-foreground">
            {children}
          </span>
        </span>
      </Link>
      <div className="flex items-center justify-between gap-4 sm:shrink-0 sm:gap-6">
        <RemoteHostDefaultToggle
          protocol={protocol}
          connectionId={connection.id}
          inline
        />
        <Link
          pathname="/connectors"
          options={options}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {t(($) => {
            return $.remoteNetworkScope.manage;
          })}
        </Link>
      </div>
    </li>
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
  return (
    <RemoteConnectionRow connection={connection} protocol="vnc">
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
    </RemoteConnectionRow>
  );
}

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
  if (!sshRows?.length && !vncRows?.length) {
    return null;
  }
  return (
    <Card className="overflow-hidden rounded-3xl border-divider">
      <ul
        aria-label={t(($) => {
          return $.remoteControlSetup.title;
        })}
        className="divide-y divide-divider"
      >
        {sshRows?.map((connection) => {
          return (
            <RemoteConnectionRow
              key={connection.id}
              connection={connection}
              protocol="ssh"
            >
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
            </RemoteConnectionRow>
          );
        })}
        {vncRows?.map((connection) => {
          return (
            <RemoteVncConnectionRow
              key={connection.id}
              connection={connection}
              sshRows={sshRows}
            />
          );
        })}
      </ul>
    </Card>
  );
}
function RemoteDirectoryContent({
  description,
  actionLabel,
  emptyActionLabel = actionLabel,
  emptyTitle,
  icon,
  onAdd,
  empty,
  loading,
  hasRows,
  children,
}: {
  readonly description: string;
  readonly actionLabel: string;
  readonly emptyActionLabel?: string;
  readonly emptyTitle: string;
  readonly icon: ReactNode;
  readonly onAdd: () => void;
  readonly empty: boolean;
  readonly loading: boolean;
  readonly hasRows: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <header className="flex min-h-10 flex-wrap items-center justify-between gap-4">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
        {(hasRows || (!loading && !empty)) && (
          <Button type="button" className={REMOTE_PAGE_ACTION} onClick={onAdd}>
            <Plus size={16} aria-hidden />
            {actionLabel}
          </Button>
        )}
      </header>
      <div className="grid gap-3">
        {loading && hasRows && (
          <p role="status" className="sr-only">
            {t(($) => {
              return $.remoteControlSetup.loading;
            })}
          </p>
        )}
        {children}
        {(empty || (loading && !hasRows)) && (
          <RemoteDirectoryPlaceholder
            loading={loading}
            icon={icon}
            title={emptyTitle}
            actionLabel={emptyActionLabel}
            onAdd={onAdd}
          />
        )}
      </div>
    </>
  );
}

function RemoteDirectoryPlaceholder({
  icon,
  title,
  actionLabel,
  onAdd,
  loading,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly actionLabel: string;
  readonly onAdd: () => void;
  readonly loading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col items-center gap-5 rounded-3xl border-divider px-6 py-10 text-center sm:py-12">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
        {icon}
      </span>
      {loading ? (
        <p role="status" className="text-base text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.loading;
          })}
        </p>
      ) : (
        <h2 className="text-base font-semibold">{title}</h2>
      )}
      <div className="min-h-10">
        {!loading && (
          <Button type="button" className={REMOTE_PAGE_ACTION} onClick={onAdd}>
            <Plus size={16} aria-hidden />
            {actionLabel}
          </Button>
        )}
      </div>
    </Card>
  );
}
function RemoteConnectionDirectory(props: { readonly vncEnabled: boolean }) {
  const identity = useLoadable(sshIdentity$);
  if (identity.state !== "hasData" || !identity.data) {
    return null;
  }
  return <OwnerRemoteConnectionDirectory key={identity.data} {...props} />;
}

function OwnerRemoteConnectionDirectory({
  vncEnabled,
}: {
  readonly vncEnabled: boolean;
}) {
  const { t } = useTranslation();
  const start = useSet(enterRemoteSetup$);
  const ssh = useLastLoadable(sshConnections$);
  const vnc = useLastLoadable(vncConnections$);
  const tailscale = useLoadable(tailscaleConfigs$);
  const access = useLoadable(cloudflareAccessConfigs$);
  const sshRows = ssh.state === "hasData" ? ssh.data : null;
  const vncRows = vncEnabled && vnc.state === "hasData" ? vnc.data : null;
  const loading =
    ssh.state === "loading" || (vncEnabled && vnc.state === "loading");
  const hasRows = [sshRows, vncRows].some((rows) => {
    return Boolean(rows?.length);
  });
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
    <RemoteDirectoryContent
      description={t(($) => {
        return $.remoteControlSetup.description;
      })}
      actionLabel={t(($) => {
        return $.remoteControlSetup.add;
      })}
      emptyActionLabel={t(($) => {
        return $.remoteControlSetup.addFirstDevice;
      })}
      emptyTitle={t(($) => {
        return $.remoteControlSetup.emptyTitle;
      })}
      icon={<Laptop size={24} aria-hidden />}
      onAdd={() => {
        start();
      }}
      empty={empty}
      loading={loading}
      hasRows={hasRows}
    >
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
      />
    </RemoteDirectoryContent>
  );
}
export function GuidedRemoteControlPanel({
  vncEnabled,
}: {
  readonly vncEnabled: boolean;
}) {
  const setup = useGet(remoteSetup$);
  if (setup) {
    return <RemoteConnectionSetup vncEnabled={vncEnabled} />;
  }
  return (
    <div className="grid gap-6">
      <RemoteConnectionDirectory vncEnabled={vncEnabled} />
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
              <p className="truncate text-sm font-semibold" title={config.name}>
                {config.name}
              </p>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
                <span>{label}</span>
                <span aria-hidden>·</span>
                <Button
                  variant="link"
                  onClick={() => {
                    updateParams(connectionParams);
                  }}
                  aria-label={`${config.name} · ${countLabel}`}
                  className="h-auto p-0 text-sm font-normal text-muted-foreground gap-1 hover:text-foreground"
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
  if (!ts?.length && !cf?.length) {
    return null;
  }
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
        if (count === 0) {
          return null;
        }
        return (
          <PrivateNetworkGroup
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
          >
            <PrivateNetworkGroupRows ts={tailscale} cf={cloudflare} />
          </PrivateNetworkGroup>
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
      <DialogContent maxWidth="sm">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.remoteControlSetup.linkedConnections;
            })}
          </DialogTitle>
          <DialogDescription className="break-words text-sm">
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
  const loading =
    access.state === "loading" ||
    (tailscaleEnabled && tailscale.state === "loading");
  const hasRows = Boolean(ts?.length || cf?.length);
  const empty = ts?.length === 0 && cf?.length === 0;
  return (
    <section
      aria-label={t(($) => {
        return $.remoteControlSetup.networkTitle;
      })}
      className="grid gap-6"
    >
      <RemoteDirectoryContent
        description={t(($) => {
          return $.remoteControlSetup.networkDescription;
        })}
        actionLabel={t(($) => {
          return $.remoteControlSetup.addNetwork;
        })}
        emptyTitle={t(($) => {
          return $.remoteControlSetup.networkEmptyTitle;
        })}
        icon={<Network size={24} aria-hidden />}
        onAdd={() => {
          open(true);
        }}
        empty={empty}
        loading={loading}
        hasRows={hasRows}
      >
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
      </RemoteDirectoryContent>
      <PrivateNetworkConnectionsDialog ts={ts} cf={cf} />
      <Link
        pathname="/connectors"
        options={{ searchParams: connectionsParams }}
        className="inline-flex items-center gap-2 justify-self-start rounded-sm text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
    </section>
  );
}
