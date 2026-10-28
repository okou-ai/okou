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
  AlertTriangle,
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
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  remoteHostDefaults$,
  setRemoteHostDefault$,
  setThreadRemoteAccess$,
} from "../../signals/remote-access.ts";
import { detach, onDomEventFn, Reason } from "../../signals/utils.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { useMediaQuery } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@okouai/ui/components/ui/drawer";
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

interface RemoteHostDefaultToggleProps {
  protocol: RemoteAccessProtocol;
  connectionId: string;
  inline?: boolean;
}

export function RemoteHostDefaultToggle(props: RemoteHostDefaultToggleProps) {
  const identity = useLoadable(sshIdentity$);
  if (identity.state !== "hasData" || !identity.data) {
    return null;
  }
  return (
    <OwnerRemoteHostDefaultToggle
      key={`${identity.data}:${props.protocol}:${props.connectionId}`}
      {...props}
    />
  );
}

function OwnerRemoteHostDefaultToggle({
  protocol,
  connectionId,
  inline = false,
}: RemoteHostDefaultToggleProps) {
  const { t } = useTranslation();
  const defaults = useLoadable(remoteHostDefaults$);
  const previousDefaults = useLastResolved(remoteHostDefaults$);
  const [saving, update] = useLoadableSet(setRemoteHostDefault$);
  const signal = useGet(pageSignal$);
  const host = resolvedDuringRefresh(defaults, previousDefaults)?.[
    protocol
  ].find((item) => {
    return item.connectionId === connectionId;
  });
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        !inline && "border-t pt-3",
      )}
    >
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
        </div>
      ) : (
        <LoadingSwitch
          checked={host?.defaultEnabled ?? false}
          disabled={!host}
          loading={
            saving.state === "loading" ||
            (!host && defaults.state === "loading")
          }
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
      <span className="min-w-0 flex-1 truncate">{host.displayName}</span>
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
            <SelectValue className="min-w-0">
              {value === "default" ? (
                <span className="flex min-w-0 w-full items-center">
                  <span className="min-w-0 truncate">{defaultLabel}</span>
                  <span className="shrink-0 whitespace-pre">
                    {` (${host.defaultEnabled ? onLabel : offLabel})`}
                  </span>
                </span>
              ) : value === "on" ? (
                onLabel
              ) : (
                offLabel
              )}
            </SelectValue>
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

interface RemoteHostChoiceActions {
  disabled: boolean;
  onChange: (
    protocol: RemoteAccessProtocol,
    connectionId: string,
    enabled: boolean | null,
  ) => void | Promise<void>;
}

function RemoteHostChoiceRow({
  protocol,
  host,
  choiceActions,
}: {
  protocol: RemoteAccessProtocol;
  host: ThreadRemoteHostAccess;
  choiceActions: RemoteHostChoiceActions;
}) {
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
      disabled={choiceActions.disabled}
      onChange={(enabled) => {
        return choiceActions.onChange(protocol, host.connectionId, enabled);
      }}
    />
  );
}

function VncHostChoiceRow({
  host,
  choiceActions,
  sshConnectionIds,
  sshHosts,
}: {
  host: ThreadRemoteHostAccess;
  choiceActions: RemoteHostChoiceActions;
  sshConnectionIds: readonly string[];
  sshHosts: readonly ThreadRemoteHostAccess[];
}) {
  const { t } = useTranslation();
  return (
    <div>
      <RemoteHostChoiceRow
        protocol="vnc"
        host={host}
        choiceActions={choiceActions}
      />
      {sshConnectionIds.map((connectionId) => {
        const sshHost = sshHosts.find((item) => {
          return item.connectionId === connectionId;
        });
        const needsSshAccess = host.enabled && sshHost?.enabled === false;
        const name =
          sshHost?.displayName ??
          t(($) => {
            return $.chat.remoteAccess.unavailableSsh;
          });
        return (
          <p
            key={connectionId}
            role={needsSshAccess ? "status" : undefined}
            className={cn(
              "flex items-start gap-1.5 px-9 pb-1 text-xs",
              needsSshAccess
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {needsSshAccess && (
              <AlertTriangle
                size={14}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 break-words">
              {needsSshAccess
                ? t(
                    ($) => {
                      return $.chat.remoteAccess.sshDisabled;
                    },
                    { name },
                  )
                : sshHost?.enabled === true
                  ? t(
                      ($) => {
                        return $.chat.remoteAccess.sshEnabled;
                      },
                      { name },
                    )
                  : t(
                      ($) => {
                        return $.chat.remoteAccess.requiresSsh;
                      },
                      { name },
                    )}
            </span>
          </p>
        );
      })}
    </div>
  );
}

interface ThreadRemoteAccessSectionProps {
  threadId?: string;
  remoteAccess$: ComposerSignals["remoteAccess$"];
  defaults$: ComposerSignals["connector"]["resources"]["remoteHostDefaults$"];
  pendingRemoteAccess: ComposerSignals["pendingRemoteAccess"];
  onOpen: () => void;
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
  defaults$,
  pendingRemoteAccess,
  onOpen,
}: ThreadRemoteAccessSectionProps) {
  const { t } = useTranslation();
  const defaults = useLoadable(defaults$);
  const access = useLoadable(remoteAccess$);
  const lastDefaults = useLastResolved(defaults$);
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
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
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
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

export function ThreadRemoteAccessDialog({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const identity = useLoadable(sshIdentity$);
  if (identity.state !== "hasData" || !identity.data) {
    return null;
  }
  return (
    <OwnerThreadRemoteAccessDialog
      key={`${identity.data}:${signals.threadId ?? "new"}`}
      signals={signals}
    />
  );
}

function OwnerThreadRemoteAccessDialog({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const { remoteAccessDialogOpen: open } = useGet(
    signals.connector.connectorUiState$,
  );
  const close = useSet(signals.connector.closeRemoteAccessDialog$);
  const triggerElement = useGet(signals.connector.triggerElement$);
  const signal = useGet(pageSignal$);
  // Keep the operation loadable above the responsive containers so resizing
  // or reopening settings cannot enable a second write during an active save.
  const [saving, update] = useLoadableSet(setThreadRemoteAccess$);
  const updatePending = useSet(signals.pendingRemoteAccess.setOverride$);
  const choiceActions: RemoteHostChoiceActions = {
    disabled: saving.state === "loading",
    onChange: async (protocol, connectionId, enabled) => {
      if (signals.threadId) {
        await update(
          { threadId: signals.threadId, protocol, connectionId, enabled },
          signal,
        );
      } else {
        updatePending(protocol, connectionId, enabled);
      }
    },
  };
  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      close();
    }
  };
  const title = t(($) => {
    return $.chat.remoteAccess.title;
  });
  const closeLabel = t(($) => {
    return $.workflows.common.close;
  });
  const choices = open ? (
    <ThreadRemoteHostChoices
      threadId={signals.threadId}
      remoteAccess$={signals.remoteAccess$}
      defaults$={signals.connector.resources.remoteHostDefaults$}
      pendingRemoteAccess={signals.pendingRemoteAccess}
      choiceActions={choiceActions}
    />
  ) : null;

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          maxWidth="lg"
          scrollable={false}
          contentClassName="flex min-h-0 flex-col gap-0 p-0"
          aria-describedby={undefined}
          closeLabel={closeLabel}
          finalFocus={() => {
            return !open && triggerElement?.isConnected
              ? triggerElement
              : false;
          }}
        >
          <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {choices}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        aria-describedby={undefined}
        closeLabel={closeLabel}
        finalFocus={() => {
          return !open && triggerElement?.isConnected ? triggerElement : false;
        }}
      >
        <DrawerHeader className="border-b pb-4">
          <DrawerTitle>{title}</DrawerTitle>
        </DrawerHeader>
        {choices}
      </DrawerContent>
    </Drawer>
  );
}

function RemoteHostLoadError() {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-2 px-2 py-2 text-sm text-destructive"
    >
      <span>
        {t(($) => {
          return $.chat.remoteAccess.loadFailed;
        })}
      </span>
    </div>
  );
}

function ThreadRemoteHostChoices({
  threadId,
  remoteAccess$,
  defaults$,
  pendingRemoteAccess,
  choiceActions,
}: {
  threadId?: string;
  remoteAccess$: ComposerSignals["remoteAccess$"];
  defaults$: ComposerSignals["connector"]["resources"]["remoteHostDefaults$"];
  pendingRemoteAccess: ComposerSignals["pendingRemoteAccess"];
  choiceActions: RemoteHostChoiceActions;
}) {
  const { t } = useTranslation();
  const defaults = useLoadable(defaults$);
  const access = useLoadable(remoteAccess$);
  const lastDefaults = useLastResolved(defaults$);
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
    <DialogBody className="min-h-0 flex-1 overscroll-contain p-2">
      {(defaults.state === "hasError" || accessFailed) && (
        <RemoteHostLoadError />
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
                protocol="ssh"
                host={host}
                choiceActions={choiceActions}
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
            const sshConnectionIds = new Set<string>();
            if (sshConnectionId) {
              sshConnectionIds.add(sshConnectionId);
            }
            if (
              configured?.security.type === "qemu_x509_gssapi" &&
              configured.security.kdc?.transport.type === "ssh"
            ) {
              sshConnectionIds.add(
                configured.security.kdc.transport.connectionId,
              );
            }
            return (
              <VncHostChoiceRow
                key={host.connectionId}
                host={host}
                choiceActions={choiceActions}
                sshConnectionIds={[...sshConnectionIds]}
                sshHosts={sshHosts}
              />
            );
          })}
        </>
      )}
    </DialogBody>
  );
}
