import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check, Info, ShieldCheck } from "lucide-react";
import {
  Button,
  cn,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
} from "@okouai/ui";
import type { VncAuthorization } from "@okouai/api-contracts/contracts/vnc-authorization";
import type { SshAuthorization } from "@okouai/api-contracts/contracts/ssh-authorization";
import type { HostAuthorizationSignals } from "../../signals/chat-page/host-authorization-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

type HostData = SshAuthorization | VncAuthorization;
type HostProtocol = "ssh" | "vnc";
function hostTarget(data: HostData) {
  return `${"username" in data ? `${data.username}@` : ""}${data.host}:${data.port}`;
}
type HostAction = "approve" | "revoke";

function HostAuthorizationDetails({
  data,
  protocol,
}: {
  data: HostData;
  protocol: HostProtocol;
}) {
  const { t } = useTranslation();
  const namespace =
    protocol === "ssh" ? "sshAuthorization" : "vncAuthorization";
  const blocker = data.approvalBlockedReason;
  return (
    <>
      {blocker && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $[namespace].blocked[blocker];
          })}
        </p>
      )}
      <div className="min-w-0 text-sm">
        <p className="break-words font-medium">{data.displayName}</p>
        <p className="break-all text-muted-foreground">{hostTarget(data)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => {
            return $[namespace].effect;
          })}
        </p>
      </div>
      <p className="break-words whitespace-pre-wrap text-sm leading-5 text-muted-foreground">
        {data.reason}
      </p>
      {"requiredSshHosts" in data && data.requiredSshHosts.length > 0 && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {t(($) => {
              return $.vncAuthorization.dependencies;
            })}
          </p>
          <ul>
            {data.requiredSshHosts.map((host) => {
              return (
                <li key={host.connectionId}>
                  {host.displayName} ·{" "}
                  {host.enabled
                    ? t(($) => {
                        return $.chat.remoteAccess.allowed;
                      })
                    : t(($) => {
                        return $.chat.remoteAccess.notAllowed;
                      })}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {blocker === "permissions_required" && (
        <ul className="break-all text-xs text-muted-foreground">
          {data.requiredPermissions.map((item) => {
            return (
              <li key={`${item.connectorSlug}/${item.permission}`}>
                {item.connectorSlug} / {item.permission}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function HostAuthorizationDetailsPopover({
  data,
  protocol,
}: {
  data: HostData;
  protocol: HostProtocol;
}) {
  const { t } = useTranslation();
  const namespace =
    protocol === "ssh" ? "sshAuthorization" : "vncAuthorization";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <IconButton
            type="button"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label={t(($) => {
              return $[namespace].details;
            })}
          />
        }
      >
        <Info size={16} aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={t(($) => {
          return $[namespace].details;
        })}
        className="max-h-[min(28rem,var(--available-height))] w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto"
      >
        <p className="text-sm font-medium">
          {t(($) => {
            return $[namespace].scope;
          })}
        </p>
        <HostAuthorizationDetails data={data} protocol={protocol} />
      </PopoverContent>
    </Popover>
  );
}

function HostAuthorizationSummary({
  data,
  failed,
  standalone,
  protocol,
}: {
  data: HostData | null;
  failed: boolean;
  standalone: boolean;
  protocol: HostProtocol;
}) {
  const { t } = useTranslation();
  const namespace =
    protocol === "ssh" ? "sshAuthorization" : "vncAuthorization";
  const scope = t(($) => {
    return $[namespace].scope;
  });
  const blocker = data?.approvalBlockedReason;
  const summary = failed
    ? t(($) => {
        return $[namespace].failed;
      })
    : blocker && !standalone
      ? t(($) => {
          return $[namespace].blocked[blocker];
        })
      : data
        ? standalone
          ? scope
          : `${hostTarget(data)} · ${scope}`
        : t(($) => {
            return $[namespace].unavailable;
          });
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3",
        standalone ? "shrink-0" : "@[640px]:flex-1",
      )}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
        {data?.status === "approved" ? (
          <Check size={22} aria-hidden />
        ) : (
          <ShieldCheck size={22} aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-5 min-w-0 items-center gap-1">
          <div
            className="truncate text-[0.9375rem] font-medium leading-5"
            aria-live="polite"
          >
            {data
              ? t(($) => {
                  return $[namespace].status[data.status];
                })
              : t(($) => {
                  return $[namespace].title;
                })}
            {data && !standalone && ` · ${data.displayName}`}
          </div>
          {data && !standalone && (
            <HostAuthorizationDetailsPopover data={data} protocol={protocol} />
          )}
        </div>
        <p
          role={failed ? "alert" : blocker ? "status" : undefined}
          className={cn(
            "mt-0.5 line-clamp-2 break-words text-sm leading-5 text-muted-foreground",
            failed && "text-destructive",
          )}
        >
          {summary}
        </p>
      </div>
    </div>
  );
}

function HostAuthorizationActions({
  data,
  busy,
  onAction,
  protocol,
}: {
  data: HostData;
  busy: boolean;
  protocol: HostProtocol;
  onAction: (action: HostAction) => void;
}) {
  const { t } = useTranslation();
  const namespace =
    protocol === "ssh" ? "sshAuthorization" : "vncAuthorization";
  const canApprove =
    data.status === "pending" ||
    (data.status === "approved" && data.continuationPending);
  return (
    <>
      {canApprove && (
        <Button
          variant="neutral"
          size="sm"
          pending={busy}
          disabled={busy || data.approvalBlockedReason !== null}
          className="h-9 text-[0.9375rem]"
          onClick={() => {
            onAction("approve");
          }}
        >
          {data.status === "approved"
            ? t(($) => {
                return $[namespace].continue;
              })
            : t(($) => {
                return $[namespace].allow;
              })}
        </Button>
      )}
      {data.status === "approved" && (
        <Button
          variant="quiet"
          size="sm"
          className="h-9"
          pending={busy}
          onClick={() => {
            onAction("revoke");
          }}
        >
          {t(($) => {
            return $.desktopShellAuthorization.revoke;
          })}
        </Button>
      )}
    </>
  );
}

export function HostAuthorizationCard({
  signals,
  standalone = false,
}: {
  signals: HostAuthorizationSignals;
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const protocol = signals.protocol;
  const namespace =
    protocol === "ssh" ? "sshAuthorization" : "vncAuthorization";
  const request = useLastLoadable(signals.request$);
  const [operation, act] = useLoadableSet(signals.act$);
  const signal = useGet(pageSignal$);
  const refresh = useSet(signals.refresh$);
  const data = request.state === "hasData" ? request.data : null;
  const loading = request.state === "loading";
  const busy = operation.state === "loading";
  const failed = operation.state === "hasError" || request.state === "hasError";
  const action = (value: HostAction) => {
    detach(act(value, signal), Reason.DomCallback);
  };
  const height = standalone ? "h-80" : "h-[136px] @[640px]:h-[88px]";
  return (
    <div
      data-testid={`${protocol}-authorization-card`}
      aria-busy={loading || busy}
      className={cn("w-full", height)}
    >
      {loading ? (
        <Skeleton
          aria-label={t(($) => {
            return $.desktopShellAuthorization.loading;
          })}
          className="h-full w-full rounded-[var(--okou-chat-card-radius)]"
        />
      ) : (
        <ChatCard
          className={cn(
            "flex h-full w-full flex-col gap-3 px-4 py-3",
            !standalone &&
              "justify-between @[640px]:flex-row @[640px]:items-center",
          )}
        >
          <HostAuthorizationSummary
            data={data}
            failed={failed}
            standalone={standalone}
            protocol={protocol}
          />
          {standalone && data && (
            <div
              role="region"
              aria-label={t(($) => {
                return $.desktopShellAuthorization.reasonTitle;
              })}
              tabIndex={0}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain"
            >
              <HostAuthorizationDetails data={data} protocol={protocol} />
            </div>
          )}
          <div
            className={cn(
              "ml-auto flex shrink-0 flex-wrap justify-end gap-2",
              standalone && "mt-auto",
            )}
          >
            {!data && !loading && (
              <Button
                variant="neutral"
                size="sm"
                onClick={() => {
                  refresh();
                }}
              >
                {t(($) => {
                  return $[namespace].retry;
                })}
              </Button>
            )}
            {data && (
              <HostAuthorizationActions
                data={data}
                busy={busy}
                onAction={action}
                protocol={protocol}
              />
            )}
          </div>
        </ChatCard>
      )}
    </div>
  );
}
