import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { ChevronRight, Monitor, Terminal } from "lucide-react";

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
        className="max-w-27 rounded-md border border-border bg-background px-1.5 py-1 text-xs"
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
}: {
  threadId?: string;
  remoteAccess$: ComposerSignals["remoteAccess$"];
}) {
  const { t } = useTranslation();
  const access = useLoadable(remoteAccess$);
  const vncHosts = useLoadable(vncConnections$);
  return (
    <details className="group border-t border-border/50 px-1 py-1">
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-state-hover">
        <ChevronRight
          size={15}
          className="transition-transform group-open:rotate-90"
        />
        {t(($) => {
          return $.chat.remoteAccess.title;
        })}
      </summary>
      <div className="max-h-48 overflow-y-auto">
        {!threadId ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.remoteAccess.startChat;
            })}
          </p>
        ) : access.state === "loading" ? (
          <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.remoteAccess.loading;
            })}
          </p>
        ) : access.state === "hasError" || !access.data ? (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
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
            {access.data.ssh.length === 0 && access.data.vnc.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {t(($) => {
                  return $.chat.remoteAccess.noHosts;
                })}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
