import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronRight, Monitor, Terminal } from "lucide-react";

import type {
  RemoteAccessProtocol,
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
import { onDomEventFn } from "../../signals/utils.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { Button } from "@okouai/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { vncConnections$, vncSshConnectionId } from "../../signals/vnc.ts";

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
        <span role="alert" className="text-xs text-destructive">
          {t(($) => {
            return $.chat.remoteAccess.loadFailed;
          })}
        </span>
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
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [saving, update] = useLoadableSet(setThreadRemoteAccess$);
  const value =
    host.overrideEnabled === null
      ? "default"
      : host.overrideEnabled
        ? "on"
        : "off";
  return (
    <label className="flex items-center gap-2 px-2 py-1.5 text-sm">
      {protocol === "ssh" ? (
        <Terminal size={15} className="shrink-0 text-muted-foreground" />
      ) : (
        <Monitor size={15} className="shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={host.displayName}>
        {host.displayName}
      </span>
      <select
        className="w-36 shrink-0 rounded-md border border-border bg-background px-1.5 py-1 text-xs"
        aria-label={`${protocol.toUpperCase()} ${host.displayName}`}
        value={value}
        disabled={saving.state === "loading"}
        onChange={onDomEventFn(async (event) => {
          const next = event.target.value;
          await update(
            {
              threadId,
              protocol,
              connectionId: host.connectionId,
              enabled: next === "default" ? null : next === "on",
            },
            signal,
          );
        })}
      >
        <option value="default">
          {t(($) => {
            return $.chat.remoteAccess.useDefault;
          })}{" "}
          (
          {host.defaultEnabled
            ? t(($) => {
                return $.chat.remoteAccess.on;
              })
            : t(($) => {
                return $.chat.remoteAccess.off;
              })}
          )
        </option>
        <option value="on">
          {t(($) => {
            return $.chat.remoteAccess.on;
          })}
        </option>
        <option value="off">
          {t(($) => {
            return $.chat.remoteAccess.off;
          })}
        </option>
      </select>
    </label>
  );
}

export function ThreadRemoteAccessSection({
  threadId,
  remoteAccess$,
  open,
  onOpenChange,
}: {
  threadId?: string;
  remoteAccess$: ComposerSignals["remoteAccess$"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const defaults = useLoadable(remoteHostDefaults$);
  const access = useLoadable(remoteAccess$);
  if (defaults.state !== "hasData" || !defaults.data) {
    return null;
  }
  const configuredCount = defaults.data.ssh.length + defaults.data.vnc.length;
  if (configuredCount === 0) {
    return null;
  }
  const enabledCount = threadId
    ? access.state === "hasData" && access.data
      ? [...access.data.ssh, ...access.data.vnc].filter((host) => {
          return host.enabled;
        }).length
      : null
    : [...defaults.data.ssh, ...defaults.data.vnc].filter((host) => {
        return host.defaultEnabled;
      }).length;
  const title = t(($) => {
    return $.chat.remoteAccess.title;
  });
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 border-t border-border/50 px-3 py-2 text-left text-sm text-foreground hover:bg-state-hover"
          >
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {enabledCount === null
                ? access.state === "hasError" || access.state === "hasData"
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
        />
      </PopoverContent>
    </Popover>
  );
}

function ThreadRemoteHostChoices({
  threadId,
  remoteAccess$,
}: {
  threadId?: string;
  remoteAccess$: ComposerSignals["remoteAccess$"];
}) {
  const { t } = useTranslation();
  const access = useLoadable(remoteAccess$);
  const vncHosts = useLoadable(vncConnections$);
  return (
    <div className="min-h-0 overflow-y-auto p-1">
      {!threadId ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.remoteAccess.startChat;
          })}
        </p>
      ) : access.state === "loading" ? (
        <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.remoteAccess.loading;
          })}
        </p>
      ) : access.state === "hasError" || !access.data ? (
        <p role="alert" className="px-2 py-2 text-sm text-destructive">
          {t(($) => {
            return $.chat.remoteAccess.loadFailed;
          })}
        </p>
      ) : (
        <>
          {access.data.ssh.length > 0 && (
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              {t(($) => {
                return $.ssh.label;
              })}
            </p>
          )}
          {access.data.ssh.map((host) => {
            return (
              <HostChoice
                key={host.connectionId}
                threadId={threadId}
                protocol="ssh"
                host={host}
              />
            );
          })}
          {access.data.vnc.length > 0 && (
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              {t(($) => {
                return $.vnc.label;
              })}
            </p>
          )}
          {access.data.vnc.map((host) => {
            const configured =
              vncHosts.state === "hasData"
                ? vncHosts.data?.find((item) => {
                    return item.id === host.connectionId;
                  })
                : undefined;
            const sshConnectionId = configured
              ? vncSshConnectionId(configured)
              : null;
            const sshName = access.data?.ssh.find((item) => {
              return item.connectionId === sshConnectionId;
            })?.displayName;
            return (
              <div key={host.connectionId}>
                <HostChoice threadId={threadId} protocol="vnc" host={host} />
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
          })}
        </>
      )}
    </div>
  );
}
