import type { DesktopShellAuthorization } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Check, Clock, Terminal, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button, cn } from "@okouai/ui";
import { i18n } from "../../i18n/index.ts";
import { resolvedAppLocale } from "../../i18n/format.ts";
import type { DesktopShellAuthorizationSignals } from "../../signals/chat-page/desktop-shell-authorization-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

function authorizationStatus(data: DesktopShellAuthorization): string {
  switch (data.status) {
    case "pending": {
      return data.approvalBlockedReason === null
        ? i18n.t(($) => {
            return $.desktopShellAuthorization.pending;
          })
        : i18n.t(($) => {
            return $.desktopShellAuthorization.unavailable;
          });
    }
    case "approved": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.approved;
      });
    }
    case "denied": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.denied;
      });
    }
    case "revoked": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.revoked;
      });
    }
    case "expired": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.expired;
      });
    }
  }
}

function AuthorizationStatus({
  data,
  loading,
}: {
  data: DesktopShellAuthorization | null;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const status = loading
    ? t(($) => {
        return $.desktopShellAuthorization.loading;
      })
    : data
      ? authorizationStatus(data)
      : t(($) => {
          return $.desktopShellAuthorization.unavailable;
        });
  return (
    <Badge
      className="max-w-[45%] shrink-0 text-[11px] font-medium text-muted-foreground"
      aria-live="polite"
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {data?.status === "approved" ? <Check /> : null}
      <span className="min-w-0 break-words">{status}</span>
    </Badge>
  );
}

function AuthorizationMetadata({
  data,
}: {
  data: DesktopShellAuthorization | null;
}) {
  const { t } = useTranslation();
  const deadline =
    data?.status === "approved"
      ? data.grantExpiresAt
      : data?.status === "pending"
        ? data.requestExpiresAt
        : null;
  return (
    <div className="min-w-0 text-xs leading-5 text-muted-foreground">
      {deadline && (
        <p className="flex items-start gap-1.5">
          <Clock size={12} className="mt-1 shrink-0" aria-hidden />
          <span>
            {t(
              ($) => {
                return $.desktopShellAuthorization.deadline;
              },
              {
                date: new Date(deadline).toLocaleString(resolvedAppLocale(), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              },
            )}
          </span>
        </p>
      )}
      <p>
        {t(($) => {
          return $.desktopShellAuthorization.scope;
        })}
      </p>
    </div>
  );
}

function AuthorizationActions({
  signals,
  data,
}: {
  signals: DesktopShellAuthorizationSignals;
  data: DesktopShellAuthorization | null;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const [action, act] = useLoadableSet(signals.act$);
  const busy = action.state === "loading";
  const blocked =
    data?.status === "pending" && data.approvalBlockedReason !== null;
  const failed = action.state === "hasError";
  return (
    <div className="ml-auto flex min-h-8 flex-wrap items-center justify-end gap-2">
      {data?.status === "pending" && (
        <>
          <Button
            size="sm"
            variant="neutral"
            disabled={busy || failed}
            onClick={() => {
              detach(act("deny", signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.desktopShellAuthorization.deny;
            })}
          </Button>
          <Button
            size="sm"
            className="bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
            disabled={busy || blocked || failed}
            onClick={() => {
              detach(act("approve", signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.desktopShellAuthorization.allow;
            })}
          </Button>
        </>
      )}
      {data?.status === "approved" && (
        <Button
          size="sm"
          variant="quiet"
          disabled={busy || failed}
          onClick={() => {
            detach(act("revoke", signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.desktopShellAuthorization.revoke;
          })}
        </Button>
      )}
      {failed && (
        <p className="basis-full text-xs text-destructive" role="alert">
          {t(($) => {
            return $.desktopShellAuthorization.actionFailed;
          })}
        </p>
      )}
    </div>
  );
}

export function DesktopShellAuthorizationCard({
  signals,
  standalone = false,
}: {
  signals: DesktopShellAuthorizationSignals;
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const request = useLoadable(signals.request$);
  const data = request.state === "hasData" ? request.data : null;
  const loading = request.state === "loading";
  return (
    <ChatCard
      data-testid="desktop-shell-authorization-card"
      className={cn(
        "flex w-full flex-col gap-3 p-4",
        !standalone &&
          "h-[272px] @[320px]:h-60 @[480px]:h-[212px] @[640px]:h-50",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <Terminal size={22} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.9375rem] font-medium leading-5">
            {t(($) => {
              return $.desktopShellAuthorization.title;
            })}
          </div>
          <div className="mt-0.5 truncate text-sm leading-5 text-muted-foreground">
            {data?.computerName ??
              t(($) => {
                return $.desktopShellAuthorization.scope;
              })}
          </div>
        </div>
        <AuthorizationStatus data={data} loading={loading} />
      </div>
      <div
        className={cn(
          "min-h-0 overflow-y-auto",
          !standalone && "flex-1 @[640px]:pl-13",
        )}
      >
        <p className="break-words text-sm leading-5">
          {data?.reason ??
            t(($) => {
              return $.desktopShellAuthorization.description;
            })}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t(($) => {
            return $.desktopShellAuthorization.terminalNotice;
          })}
        </p>
        {data?.status === "pending" &&
          data.approvalBlockedReason !== null &&
          data.approvalBlockedReason !== "run_unavailable" && (
            <p
              className="mt-1 text-xs leading-5 text-muted-foreground"
              aria-live="polite"
            >
              {t(($) => {
                return $.desktopShellAuthorization.waiting;
              })}
            </p>
          )}
      </div>
      <div
        className={cn(
          "mt-auto flex flex-wrap items-end justify-between gap-3",
          !standalone && "@[640px]:pl-13",
        )}
      >
        <AuthorizationMetadata data={data} />
        <AuthorizationActions signals={signals} data={data} />
      </div>
    </ChatCard>
  );
}
