import {
  useGet,
  useLastResolved,
  useLoadable,
  useSet,
  type Loadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ChevronRight,
  Monitor,
  Network,
  Terminal,
} from "lucide-react";

import type {
  InitialRemoteAccessOverride,
  RemoteAccessProtocol,
  RemoteHostDefault,
  ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  remoteHostDefaults$,
  setRemoteHostDefault$,
  setThreadRemoteAccess$,
} from "../../signals/remote-access.ts";
import { invalidateRemoteAccess$ } from "../../signals/remote-access-refresh.ts";
import { detach, onDomEventFn, Reason } from "../../signals/utils.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { Button } from "@okouai/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { vncConnections$, vncSshConnectionId } from "../../signals/vnc.ts";
import { sshIdentity$ } from "../../signals/ssh.ts";

export function RemoteHostDefaultToggle({
  protocol,
  connectionId,
}: {
  protocol: RemoteAccessProtocol;
  connectionId: string;
}) {
  const { t } = useTranslation();
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ThreadRemoteAccess];
  const defaults = useLoadable(remoteHostDefaults$);
  const retry = useSet(invalidateRemoteAccess$);
  const [saving, update] = useLoadableSet(setRemoteHostDefault$);
  const signal = useGet(pageSignal$);
  if (!enabled) {
    return null;
  }
  const host =
    defaults.state === "hasData"
      ? defaults.data?.[protocol].find((item) => {
          return item.connectionId === connectionId;
        })
      : undefined;
  return (
    <div className="flex items-center justify-between gap-3 border-t pt-3">
      <span className="text-sm text-foreground">
        {t(($) => {
          return $.chat.remoteAccess.defaultEnabled;
        })}
      </span>
      {defaults.state === "hasError" ? (
        <div className="flex items-center gap-2">
          <span role="alert" className="text-xs text-destructive">
            {t(($) => {
              return $.chat.remoteAccess.loadFailed;
            })}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {t(($) => {
              return $.chat.remoteAccess.retry;
            })}
          </Button>
        </div>
      ) : (
        <LoadingSwitch
          checked={host?.defaultEnabled ?? false}
          disabled={!host}
          loading={saving.state === "loading" || defaults.state === "loading"}
          ariaLabel={t(($) => {
            return $.chat.remoteAccess.defaultEnabled;
          })}
          onCheckedChange={onDomEventFn(async (checked) => {
            await update(protocol, connectionId, checked, signal);
          })}
        />
      )}
    </div>
  );
}

function HostChoice({
  threadId,
  protocol,
  host,
}: {
  threadId: string;
  protocol: RemoteAccessProtocol;
  host: ThreadRemoteHostAccess;
}) {
  const signal = useGet(pageSignal$);
  const [saving, update] = useLoadableSet(setThreadRemoteAccess$);
  const value =
    host.overrideEnabled === null
      ? "default"
      : host.overrideEnabled
        ? "on"
        : "off";
  return (
    <HostChoiceSelect
      protocol={protocol}
      host={host}
      value={value}
      disabled={saving.state === "loading"}
      onChange={async (next) => {
        await update(
          {
            threadId,
            protocol,
            connectionId: host.connectionId,
            enabled: next,
          },
          signal,
        );
      }}
    />
  );
}

function pendingHostAccess(
  protocol: RemoteAccessProtocol,
  host: RemoteHostDefault,
  overrides: readonly InitialRemoteAccessOverride[],
): ThreadRemoteHostAccess {
  const overrideEnabled =
    overrides.find((item) => {
      return (
        item.protocol === protocol && item.connectionId === host.connectionId
      );
    })?.enabled ?? null;
  return {
    ...host,
    overrideEnabled,
    enabled: overrideEnabled ?? host.defaultEnabled,
    source: overrideEnabled === null ? "default" : "override",
  };
}

function countPendingEnabledHosts(
  defaults: {
    readonly ssh: readonly RemoteHostDefault[];
    readonly vnc: readonly RemoteHostDefault[];
  },
  overrides: readonly InitialRemoteAccessOverride[],
): number {
  const choices = new Map(
    overrides.map((item) => {
      return [`${item.protocol}:${item.connectionId}`, item.enabled] as const;
    }),
  );
  let count = 0;
  for (const [protocol, hosts] of [
    ["ssh", defaults.ssh],
    ["vnc", defaults.vnc],
  ] as const) {
    for (const host of hosts) {
      if (
        choices.get(`${protocol}:${host.connectionId}`) ??
        host.defaultEnabled
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function visibleHostChoices(
  protocol: RemoteAccessProtocol,
  threadId: string | undefined,
  accessHosts: readonly ThreadRemoteHostAccess[] | undefined,
  defaultHosts: readonly RemoteHostDefault[] | undefined,
  pendingOverrides: readonly InitialRemoteAccessOverride[],
): readonly ThreadRemoteHostAccess[] {
  return threadId
    ? (accessHosts ?? [])
    : (defaultHosts ?? []).map((host) => {
        return pendingHostAccess(protocol, host, pendingOverrides);
      });
}

function resolvedDuringRefresh<T>(
  loadable: Loadable<T>,
  previous: T | undefined,
): T | null {
  if (loadable.state === "hasData") {
    return loadable.data;
  }
  return loadable.state === "loading" ? (previous ?? null) : null;
}

function HostChoiceSelect({
  protocol,
  host,
  value,
  disabled,
  onChange,
}: {
  protocol: RemoteAccessProtocol;
  host: ThreadRemoteHostAccess;
  value: "default" | "on" | "off";
  disabled: boolean;
  onChange: (enabled: boolean | null) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const defaultLabel = t(($) => {
    return $.chat.remoteAccess.default;
  });
  const onLabel = t(($) => {
    return $.chat.remoteAccess.on;
  });
  const offLabel = t(($) => {
    return $.chat.remoteAccess.off;
  });
  const defaultOnLabel = `${defaultLabel} (${onLabel})`;
  const defaultOffLabel = `${defaultLabel} (${offLabel})`;
  const items = [
    {
      value: "default",
      label: host.defaultEnabled ? defaultOnLabel : defaultOffLabel,
    },
    { value: "on", label: onLabel },
    { value: "off", label: offLabel },
  ];
  const sizingLabels = [defaultOnLabel, defaultOffLabel, onLabel, offLabel];
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
      {protocol === "ssh" ? (
        <Terminal size={15} className="shrink-0 text-muted-foreground" />
      ) : (
        <Monitor size={15} className="shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={host.displayName}>
        {host.displayName}
      </span>
      <Select
        items={items}
        value={value}
        disabled={disabled}
        onValueChange={(next, details) => {
          if (next !== "default" && next !== "on" && next !== "off") {
            details.cancel();
            return;
          }
          detach(
            onChange(next === "default" ? null : next === "on"),
            Reason.DomCallback,
          );
        }}
      >
        <div className="relative grid min-w-0 max-w-[min(12rem,calc(100%-1.5rem))] shrink-0 grid-cols-[minmax(0,1fr)]">
          {sizingLabels.map((label) => {
            return (
              <span
                key={label}
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 flex h-8 items-center gap-2 whitespace-nowrap border px-3 py-1 pr-3.5 text-sm"
              >
                {label}
                <span className="h-4 w-4 shrink-0" />
              </span>
            );
          })}
          <SelectTrigger
            variant="neutral"
            className="col-start-1 row-start-1 h-8 min-w-0 w-full py-1 text-sm"
            aria-label={`${protocol.toUpperCase()} ${host.displayName}`}
          >
            <SelectValue className="min-w-0" />
          </SelectTrigger>
        </div>
        <SelectContent align="start" className="w-max max-w-[calc(100vw-2rem)]">
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
  );
}

function PendingHostChoice({
  protocol,
  host,
  pendingRemoteAccess,
}: {
  protocol: RemoteAccessProtocol;
  host: ThreadRemoteHostAccess;
  pendingRemoteAccess: ComposerSignals["pendingRemoteAccess"];
}) {
  const update = useSet(pendingRemoteAccess.setOverride$);
  return (
    <HostChoiceSelect
      protocol={protocol}
      host={host}
      value={
        host.overrideEnabled === null
          ? "default"
          : host.overrideEnabled
            ? "on"
            : "off"
      }
      disabled={false}
      onChange={(enabled) => {
        update(protocol, host.connectionId, enabled);
      }}
    />
  );
}

function RemoteHostChoiceRow({
  threadId,
  protocol,
  host,
  pendingRemoteAccess,
}: {
  threadId?: string;
  protocol: RemoteAccessProtocol;
  host: ThreadRemoteHostAccess;
  pendingRemoteAccess: ComposerSignals["pendingRemoteAccess"];
}) {
  return threadId ? (
    <HostChoice threadId={threadId} protocol={protocol} host={host} />
  ) : (
    <PendingHostChoice
      protocol={protocol}
      host={host}
      pendingRemoteAccess={pendingRemoteAccess}
    />
  );
}

function VncHostChoiceRow({
  threadId,
  host,
  pendingRemoteAccess,
  sshConnectionId,
  sshHosts,
}: {
  threadId?: string;
  host: ThreadRemoteHostAccess;
  pendingRemoteAccess: ComposerSignals["pendingRemoteAccess"];
  sshConnectionId: string | null;
  sshHosts: readonly ThreadRemoteHostAccess[];
}) {
  const { t } = useTranslation();
  const sshName = sshHosts.find((item) => {
    return item.connectionId === sshConnectionId;
  })?.displayName;
  return (
    <div>
      <RemoteHostChoiceRow
        threadId={threadId}
        protocol="vnc"
        host={host}
        pendingRemoteAccess={pendingRemoteAccess}
      />
      {sshConnectionId && (
        <p className="px-9 pb-1 text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.chat.remoteAccess.requiresSsh;
            },
            {
              name:
                sshName ??
                t(($) => {
                  return $.chat.remoteAccess.unavailableSsh;
                }),
            },
          )}
        </p>
      )}
    </div>
  );
}

interface ThreadRemoteAccessSectionProps {
  threadId?: string;
  remoteAccess$: ComposerSignals["remoteAccess$"];
  pendingRemoteAccess: ComposerSignals["pendingRemoteAccess"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ThreadRemoteAccessSection(
  props: ThreadRemoteAccessSectionProps,
) {
  const identity = useLoadable(sshIdentity$);
  if (identity.state !== "hasData" || !identity.data) {
    return null;
  }
  // Remount retained responses when the owner or chat changes.
  return (
    <OwnerThreadRemoteAccessSection
      key={`${identity.data}:${props.threadId ?? "new"}`}
      {...props}
    />
  );
}

function OwnerThreadRemoteAccessSection({
  threadId,
  remoteAccess$,
  pendingRemoteAccess,
  open,
  onOpenChange,
}: ThreadRemoteAccessSectionProps) {
  const { t } = useTranslation();
  const defaults = useLoadable(remoteHostDefaults$);
  const access = useLoadable(remoteAccess$);
  const lastDefaults = useLastResolved(remoteHostDefaults$);
  const lastAccess = useLastResolved(remoteAccess$);
  const pendingOverrides = useGet(pendingRemoteAccess.overrides$);
  const defaultData = resolvedDuringRefresh(defaults, lastDefaults);
  const accessData = resolvedDuringRefresh(access, lastAccess);
  if (
    (defaults.state === "loading" && !defaultData) ||
    (defaults.state === "hasData" && !defaults.data)
  ) {
    return null;
  }
  const configuredCount = defaultData
    ? defaultData.ssh.length + defaultData.vnc.length
    : null;
  if (configuredCount === 0) {
    return null;
  }
  const enabledCount = threadId
    ? accessData
      ? [...accessData.ssh, ...accessData.vnc].filter((host) => {
          return host.enabled;
        }).length
      : null
    : defaultData
      ? countPendingEnabledHosts(defaultData, pendingOverrides)
      : null;
  const title = t(($) => {
    return $.chat.remoteAccess.title;
  });
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border-t border-border/50 px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-state-hover"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              <Network size={16} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {enabledCount === null
                ? defaults.state === "hasError" ||
                  (threadId &&
                    (access.state === "hasError" || access.state === "hasData"))
                  ? t(($) => {
                      return $.chat.remoteAccess.loadFailed;
                    })
                  : t(($) => {
                      return $.chat.remoteAccess.loading;
                    })
                : t(
                    ($) => {
                      return $.chat.remoteAccess.enabledCount;
                    },
                    { count: enabledCount },
                  )}
            </span>
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          </button>
        }
      />
      <PopoverContent
        side="right"
        align="start"
        className="flex max-h-[min(25rem,var(--available-height))] w-80 flex-col overflow-hidden p-0"
        aria-label={title}
      >
        <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border/60 pl-1.5 pr-2 text-sm font-medium text-foreground">
          <Button
            type="button"
            variant="quiet"
            size="icon-xs"
            aria-label={t(($) => {
              return $.chat.connectors.back;
            })}
            onClick={() => {
              return onOpenChange(false);
            }}
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Button>
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </div>
        <ThreadRemoteHostChoices
          threadId={threadId}
          remoteAccess$={remoteAccess$}
          pendingRemoteAccess={pendingRemoteAccess}
        />
      </PopoverContent>
    </Popover>
  );
}

function ThreadRemoteHostChoices({
  threadId,
  remoteAccess$,
  pendingRemoteAccess,
}: {
  threadId?: string;
  remoteAccess$: ComposerSignals["remoteAccess$"];
  pendingRemoteAccess: ComposerSignals["pendingRemoteAccess"];
}) {
  const { t } = useTranslation();
  const retry = useSet(invalidateRemoteAccess$);
  const defaults = useLoadable(remoteHostDefaults$);
  const access = useLoadable(remoteAccess$);
  const lastDefaults = useLastResolved(remoteHostDefaults$);
  const lastAccess = useLastResolved(remoteAccess$);
  const pendingOverrides = useGet(pendingRemoteAccess.overrides$);
  const vncHosts = useLoadable(vncConnections$);
  const defaultData = resolvedDuringRefresh(defaults, lastDefaults);
  const accessData = resolvedDuringRefresh(access, lastAccess);
  const accessFailed =
    Boolean(threadId) &&
    (access.state === "hasError" ||
      (access.state === "hasData" && !access.data));
  const sshHosts = visibleHostChoices(
    "ssh",
    threadId,
    accessData?.ssh,
    defaultData?.ssh,
    pendingOverrides,
  );
  const vncHostChoices = visibleHostChoices(
    "vnc",
    threadId,
    accessData?.vnc,
    defaultData?.vnc,
    pendingOverrides,
  );
  return (
    <div className="min-h-0 overflow-y-auto p-1">
      {(defaults.state === "hasError" || accessFailed) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-2 py-2 text-sm text-destructive"
        >
          <span>
            {t(($) => {
              return $.chat.remoteAccess.loadFailed;
            })}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {t(($) => {
              return $.chat.remoteAccess.retry;
            })}
          </Button>
        </div>
      )}
      {threadId && access.state === "loading" && !accessData ? (
        <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.remoteAccess.loading;
          })}
        </p>
      ) : threadId && accessFailed ? null : (
        <>
          {sshHosts.length > 0 && (
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              {t(($) => {
                return $.ssh.label;
              })}
            </p>
          )}
          {sshHosts.map((host) => {
            return (
              <RemoteHostChoiceRow
                key={host.connectionId}
                threadId={threadId}
                protocol="ssh"
                host={host}
                pendingRemoteAccess={pendingRemoteAccess}
              />
            );
          })}
          {vncHostChoices.length > 0 && (
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              {t(($) => {
                return $.vnc.label;
              })}
            </p>
          )}
          {vncHostChoices.map((host) => {
            const configured =
              vncHosts.state === "hasData"
                ? vncHosts.data?.find((item) => {
                    return item.id === host.connectionId;
                  })
                : undefined;
            const sshConnectionId = configured
              ? vncSshConnectionId(configured)
              : null;
            return (
              <VncHostChoiceRow
                key={host.connectionId}
                threadId={threadId}
                host={host}
                pendingRemoteAccess={pendingRemoteAccess}
                sshConnectionId={sshConnectionId}
                sshHosts={sshHosts}
              />
            );
          })}
        </>
      )}
    </div>
  );
}
