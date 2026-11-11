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
  Loader2,
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
  changeDialogRemoteAccess$,
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
import {
  invalidateVnc$,
  vncConnections$,
  vncSshConnectionId,
} from "../../signals/vnc.ts";
import { sshIdentity$ } from "../../signals/ssh.ts";
import { Button } from "@okouai/ui/components/ui/button";
import { Link } from "../router/link.tsx";
import { ROUTES } from "../../signals/route-paths.ts";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";

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

export function AccessChoiceSelect({
  ariaLabel,
  defaultEnabled,
  value,
  readOnly,
  busy = readOnly,
  onChange,
  popupFocus,
}: {
  ariaLabel: string;
  defaultEnabled: boolean;
  value: "default" | "on" | "off";
  readOnly: boolean;
  busy?: boolean;
  onChange: (enabled: boolean | null) => void | Promise<void>;
  popupFocus?: {
    readonly remember: (popup: HTMLDivElement) => void;
    readonly restore: () => false;
  };
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
      label: defaultEnabled ? defaultOnLabel : defaultOffLabel,
    },
    { value: "on", label: onLabel },
    { value: "off", label: offLabel },
  ];
  const sizingLabels = [defaultOnLabel, defaultOffLabel, onLabel, offLabel];
  return (
    <Select
      items={items}
      value={value}
      readOnly={readOnly}
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
          className="col-start-1 row-start-1 h-8 min-w-0 w-full py-1 text-sm aria-readonly:cursor-wait aria-readonly:opacity-50"
          aria-label={ariaLabel}
          aria-busy={busy || undefined}
        >
          <SelectValue className="min-w-0">
            {value === "default" ? (
              <span className="flex min-w-0 w-full items-center">
                <span className="min-w-0 truncate">{defaultLabel}</span>
                <span className="shrink-0 whitespace-pre">
                  {` (${defaultEnabled ? onLabel : offLabel})`}
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
      <SelectContent
        align="start"
        className="w-max max-w-[calc(100vw-2rem)]"
        onFocus={
          popupFocus
            ? (event) => {
                popupFocus.remember(event.currentTarget);
              }
            : undefined
        }
        finalFocus={popupFocus?.restore}
      >
        {items.map((item) => {
          return (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function HostChoiceSelect({
  protocol,
  host,
  value,
  readOnly,
  busy,
  onChange,
}: {
  protocol: RemoteAccessProtocol;
  host: ThreadRemoteHostAccess;
  value: "default" | "on" | "off";
  readOnly: boolean;
  busy?: boolean;
  onChange: (enabled: boolean | null) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm">
      {protocol === "ssh" ? (
        <Terminal size={15} className="shrink-0 text-muted-foreground" />
      ) : (
        <Monitor size={15} className="shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <span className="block break-words [overflow-wrap:anywhere]">
          {host.displayName}
        </span>
        <p className="mt-1 text-xs text-muted-foreground">
          {protocol.toUpperCase()}
          {" · "}
          {host.enabled
            ? t(($) => {
                return $.chat.remoteAccess.allowed;
              })
            : t(($) => {
                return $.chat.remoteAccess.notAllowed;
              })}
          {" · "}
          {host.source === "default"
            ? t(($) => {
                return $.chat.remoteAccess.default;
              })
            : t(($) => {
                return $.chat.remoteAccess.fromChat;
              })}
        </p>
      </div>
      <AccessChoiceSelect
        ariaLabel={`${protocol.toUpperCase()} ${host.displayName}`}
        defaultEnabled={host.defaultEnabled}
        value={value}
        readOnly={readOnly}
        busy={busy}
        onChange={onChange}
      />
    </div>
  );
}

interface RemoteHostChoiceActions {
  readOnly: boolean;
  busy: boolean;
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
      readOnly={choiceActions.readOnly}
      busy={choiceActions.busy}
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
        const needsSshAccess = host.enabled && sshHost?.enabled !== true;
        const name =
          sshHost?.displayName ??
          t(($) => {
            return $.chat.remoteAccess.unavailableSsh;
          });
        return (
          <div
            key={connectionId}
            role={needsSshAccess ? "status" : undefined}
            className={cn(
              "ml-9 flex flex-wrap items-center gap-2 px-3 pb-2 text-xs",
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
            {needsSshAccess && sshHost && (
              <Button
                variant="quiet"
                size="sm"
                pending={choiceActions.busy}
                disabled={choiceActions.readOnly}
                focusableWhenDisabled
                aria-label={t(
                  ($) => {
                    return $.chat.remoteAccess.enableSsh;
                  },
                  { name },
                )}
                className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-xs"
                onClick={onDomEventFn(async () => {
                  await choiceActions.onChange("ssh", connectionId, true);
                })}
              >
                {t(($) => {
                  return $.chat.remoteAccess.enableInChat;
                })}
              </Button>
            )}
          </div>
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
  const { remoteAccessDialogOpen: open, remoteAccessScopeId: scopeId } = useGet(
    signals.connector.connectorUiState$,
  );
  const close = useSet(signals.connector.closeRemoteAccessDialog$);
  const triggerElement = useGet(signals.connector.triggerElement$);
  const signal = useGet(pageSignal$);
  // Keep the operation loadable above the responsive containers so resizing
  // or reopening settings cannot enable a second write during an active save.
  const [operation, update] = useLoadableSet(changeDialogRemoteAccess$);
  const choiceActions: RemoteHostChoiceActions = {
    readOnly: operation.state === "loading" || operation.state === "hasError",
    busy: operation.state === "loading",
    onChange: async (protocol, connectionId, enabled) => {
      await update(
        signals,
        { type: "choose", protocol, connectionId, enabled },
        signal,
      );
    },
  };
  const reload = onDomEventFn(async () => {
    await update(signals, { type: "reload" }, signal);
  });
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
      signals={signals}
      operation={operation}
      onReload={reload}
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
          aria-describedby={scopeId}
          closeLabel={closeLabel}
          finalFocus={() => {
            return !open && triggerElement?.isConnected
              ? triggerElement
              : false;
          }}
        >
          <DialogHeader className="shrink-0 px-6 pb-3 pt-5 pr-14">
            <DialogTitle>{title}</DialogTitle>
            <p id={scopeId} className="text-xs text-muted-foreground">
              {t(($) => {
                return $.chat.remoteAccess.scope;
              })}
            </p>
          </DialogHeader>
          {choices}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        aria-describedby={scopeId}
        closeLabel={closeLabel}
        finalFocus={() => {
          return !open && triggerElement?.isConnected ? triggerElement : false;
        }}
      >
        <DrawerHeader className="pb-1">
          <DrawerTitle>{title}</DrawerTitle>
          <p id={scopeId} className="text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.remoteAccess.scope;
            })}
          </p>
        </DrawerHeader>
        {choices}
      </DrawerContent>
    </Drawer>
  );
}

type DialogOperation =
  Loadable<"draft" | "saved" | "reloaded"> | { state: "idle" };
interface RemoteAccessEntry {
  protocol: RemoteAccessProtocol;
  host: ThreadRemoteHostAccess;
}
type VncConfiguration = Loadable<readonly VncConnectionResponse[] | null>;

function RemoteAccessFilters({
  signals,
  entries,
  blocked,
  hidden,
}: {
  signals: ComposerSignals;
  entries: readonly RemoteAccessEntry[];
  blocked: boolean;
  hidden: boolean;
}) {
  const { t } = useTranslation();
  const ui = useGet(signals.connector.connectorUiState$);
  const updateUi = useSet(signals.connector.updateConnectorUiState$);
  if (hidden || (entries.length <= 6 && ui.remoteAccessFilter === "all")) {
    return null;
  }
  const allowed = entries.filter(({ host }) => {
    return host.enabled;
  }).length;
  return (
    <div className="flex shrink-0 flex-wrap gap-1 px-4 pb-2">
      {(["all", "allowed"] as const).map((filter) => {
        return (
          <Button
            key={filter}
            variant="quiet"
            size="sm"
            className={cn(
              "text-xs",
              ui.remoteAccessFilter === filter && "bg-gray-50 text-foreground",
            )}
            aria-pressed={ui.remoteAccessFilter === filter}
            disabled={blocked}
            onClick={() => {
              return updateUi({
                remoteAccessFilter: filter,
                remoteAccessEditedHosts: [],
              });
            }}
          >
            {filter === "all"
              ? t(($) => {
                  return $.chat.remoteAccess.all;
                })
              : t(($) => {
                  return $.chat.remoteAccess.allowed;
                })}
            <span className="text-muted-foreground">
              {filter === "all" ? entries.length : allowed}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

function RemoteAccessNotices({
  operation,
  readFailed,
  hasVnc,
  configuration,
  onReload,
}: {
  operation: DialogOperation;
  readFailed: boolean;
  hasVnc: boolean;
  configuration: VncConfiguration;
  onReload: (event: unknown) => void;
}) {
  const { t } = useTranslation();
  const reloadVnc = useSet(invalidateVnc$);
  const vncFailed = hasVnc && configuration.state === "hasError";
  const vncLoading = hasVnc && configuration.state === "loading";
  return (
    <>
      {!readFailed && (vncFailed || vncLoading) && (
        <div
          role={vncFailed ? "alert" : "status"}
          className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-gray-50 p-3 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1">
            {vncFailed
              ? t(($) => {
                  return $.vnc.loadFailed;
                })
              : t(($) => {
                  return $.vnc.loading;
                })}
          </span>
          {vncFailed && (
            <Button variant="outline" size="sm" onClick={reloadVnc}>
              {t(($) => {
                return $.chat.remoteAccess.reload;
              })}
            </Button>
          )}
        </div>
      )}
      {(readFailed || operation.state === "hasError") && (
        <div
          role="alert"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-gray-50 p-3 text-xs text-foreground"
        >
          <span className="min-w-0 flex-1">
            {readFailed
              ? t(($) => {
                  return $.chat.remoteAccess.loadFailed;
                })
              : t(($) => {
                  return $.chat.remoteAccess.saveUnconfirmed;
                })}
          </span>
          <Button
            variant="outline"
            size="sm"
            pending={operation.state === "loading"}
            onClick={onReload}
          >
            {t(($) => {
              return $.chat.remoteAccess.reload;
            })}
          </Button>
        </div>
      )}
    </>
  );
}

function VncConnectionChoice({
  host,
  configuration,
  sshHosts,
  actions,
}: {
  host: ThreadRemoteHostAccess;
  configuration: VncConfiguration;
  sshHosts: readonly ThreadRemoteHostAccess[];
  actions: RemoteHostChoiceActions;
}) {
  const configured =
    configuration.state === "hasData"
      ? configuration.data?.find((item) => {
          return item.id === host.connectionId;
        })
      : undefined;
  const transport = configured ? vncSshConnectionId(configured) : null;
  const dependencies = new Set<string>();
  if (transport) {
    dependencies.add(transport);
  }
  if (
    configured?.security.type === "qemu_x509_gssapi" &&
    configured.security.kdc?.transport.type === "ssh"
  ) {
    dependencies.add(configured.security.kdc.transport.connectionId);
  }
  const loading = configuration.state === "loading";
  return (
    <VncHostChoiceRow
      host={host}
      sshConnectionIds={[...dependencies]}
      sshHosts={sshHosts}
      choiceActions={{
        ...actions,
        readOnly:
          actions.readOnly || loading || configuration.state === "hasError",
        busy: actions.busy || loading,
      }}
    />
  );
}

function RemoteAccessSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3 p-3">
      {[0, 1].map((index) => {
        return (
          <div key={index} className="flex h-10 items-center gap-3">
            <div className="h-4 w-4 rounded bg-gray-50" />
            <div className="h-3 w-1/2 rounded bg-gray-50" />
            <div className="ml-auto h-8 w-28 rounded-lg bg-gray-50" />
          </div>
        );
      })}
    </div>
  );
}

function RemoteAccessInventory({
  signals,
  entries,
  sshHosts,
  configuration,
  actions,
  initialLoading,
  readFailed,
}: {
  signals: ComposerSignals;
  entries: readonly RemoteAccessEntry[];
  sshHosts: readonly ThreadRemoteHostAccess[];
  configuration: VncConfiguration;
  actions: RemoteHostChoiceActions;
  initialLoading: boolean;
  readFailed: boolean;
}) {
  const { t } = useTranslation();
  const ui = useGet(signals.connector.connectorUiState$);
  const updateUi = useSet(signals.connector.updateConnectorUiState$);
  const filtered = ui.remoteAccessFilter === "allowed";
  const visible = entries.filter(({ protocol, host }) => {
    return (
      !filtered ||
      host.enabled ||
      ui.remoteAccessEditedHosts.includes(`${protocol}:${host.connectionId}`)
    );
  });
  if (readFailed) {
    return null;
  }
  if (initialLoading) {
    return <RemoteAccessSkeleton />;
  }
  if (visible.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        <p>
          {filtered
            ? t(($) => {
                return $.chat.remoteAccess.noneAllowed;
              })
            : t(($) => {
                return $.chat.remoteAccess.noConnections;
              })}
        </p>
        {filtered && (
          <Button
            variant="quiet"
            size="sm"
            className="mt-3"
            onClick={() => {
              updateUi({
                remoteAccessFilter: "all",
                remoteAccessEditedHosts: [],
              });
            }}
          >
            {t(($) => {
              return $.chat.remoteAccess.showAll;
            })}
          </Button>
        )}
      </div>
    );
  }
  const showHint =
    filtered &&
    visible.some(({ host }) => {
      return !host.enabled;
    });
  return (
    <>
      <div
        role="list"
        aria-label={t(($) => {
          return $.chat.remoteAccess.connections;
        })}
      >
        {visible.map(({ protocol, host }) => {
          return (
            <div key={`${protocol}:${host.connectionId}`} role="listitem">
              {protocol === "ssh" ? (
                <RemoteHostChoiceRow
                  protocol={protocol}
                  host={host}
                  choiceActions={actions}
                />
              ) : (
                <VncConnectionChoice
                  host={host}
                  configuration={configuration}
                  sshHosts={sshHosts}
                  actions={actions}
                />
              )}
            </div>
          );
        })}
      </div>
      {showHint && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.remoteAccess.filterHint;
          })}
        </p>
      )}
    </>
  );
}

function RemoteAccessFooter({
  operation,
  refreshing,
  readFailed,
  threadId,
}: {
  operation: DialogOperation;
  refreshing: boolean;
  readFailed: boolean;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const text = refreshing
    ? t(($) => {
        return $.chat.remoteAccess.loading;
      })
    : readFailed || operation.state === "hasError"
      ? t(($) => {
          return $.chat.remoteAccess.needsReload;
        })
      : operation.state === "loading"
        ? t(($) => {
            return $.chat.remoteAccess.saving;
          })
        : !threadId
          ? t(($) => {
              return $.chat.remoteAccess.draft;
            })
          : operation.state === "hasData" && operation.data === "saved"
            ? t(($) => {
                return $.chat.remoteAccess.saved;
              })
            : t(($) => {
                return $.chat.remoteAccess.autoSave;
              });
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs text-muted-foreground">
      <span role="status" className="flex min-w-0 flex-1 items-center gap-2">
        {(refreshing || operation.state === "loading") && (
          <Loader2
            size={14}
            className="shrink-0 animate-spin"
            aria-hidden="true"
          />
        )}
        {text}
      </span>
      <Link
        pathname={ROUTES.connectors}
        options={{
          searchParams: new URLSearchParams({
            scope: "remote-control",
            ...(threadId ? { returnThread: threadId } : {}),
          }),
        }}
        className="shrink-0 rounded-md px-2 py-1.5 hover:bg-state-hover hover:text-foreground"
      >
        {t(($) => {
          return $.chat.remoteAccess.manage;
        })}
      </Link>
    </div>
  );
}

function ThreadRemoteHostChoices({
  signals,
  operation,
  onReload,
  choiceActions,
}: {
  signals: ComposerSignals;
  operation: DialogOperation;
  onReload: (event: unknown) => void;
  choiceActions: RemoteHostChoiceActions;
}) {
  const { threadId, remoteAccess$, pendingRemoteAccess } = signals;
  const defaults$ = signals.connector.resources.remoteHostDefaults$;
  const defaults = useLoadable(defaults$);
  const access = useLoadable(remoteAccess$);
  const lastDefaults = useLastResolved(defaults$);
  const lastAccess = useLastResolved(remoteAccess$);
  const pendingOverrides = useGet(pendingRemoteAccess.overrides$);
  const configuration = useLoadable(vncConnections$);
  const defaultData = resolvedDuringRefresh(defaults, lastDefaults);
  const accessData = resolvedDuringRefresh(access, lastAccess);
  const sshHosts = visibleHostChoices(
    "ssh",
    threadId,
    accessData?.ssh,
    defaultData?.ssh,
    pendingOverrides,
  );
  const vncHosts = visibleHostChoices(
    "vnc",
    threadId,
    accessData?.vnc,
    defaultData?.vnc,
    pendingOverrides,
  );
  const entries: RemoteAccessEntry[] = [
    ...sshHosts.map((host) => {
      return { protocol: "ssh" as const, host };
    }),
    ...vncHosts.map((host) => {
      return { protocol: "vnc" as const, host };
    }),
  ];
  const accessFailed =
    Boolean(threadId) &&
    (access.state === "hasError" ||
      (access.state === "hasData" && !access.data));
  const readFailed = defaults.state === "hasError" || accessFailed;
  const refreshing =
    defaults.state === "loading" ||
    (Boolean(threadId) && access.state === "loading");
  const initialLoading =
    (defaults.state === "loading" && !defaultData) ||
    (Boolean(threadId) && access.state === "loading" && !accessData);
  const actions: RemoteHostChoiceActions = {
    ...choiceActions,
    readOnly: choiceActions.readOnly || refreshing || readFailed,
    busy: choiceActions.busy || refreshing,
  };
  return (
    <>
      <RemoteAccessFilters
        signals={signals}
        entries={entries}
        blocked={actions.readOnly}
        hidden={readFailed || initialLoading}
      />
      <DialogBody className="max-h-[min(28rem,50dvh)] min-h-0 flex-1 overscroll-contain px-3 py-1">
        <RemoteAccessNotices
          operation={operation}
          readFailed={readFailed}
          hasVnc={vncHosts.length > 0}
          configuration={configuration}
          onReload={onReload}
        />
        <RemoteAccessInventory
          signals={signals}
          entries={entries}
          sshHosts={sshHosts}
          configuration={configuration}
          actions={actions}
          initialLoading={initialLoading}
          readFailed={readFailed}
        />
      </DialogBody>
      <RemoteAccessFooter
        operation={operation}
        refreshing={refreshing}
        readFailed={readFailed}
        threadId={threadId}
      />
    </>
  );
}
