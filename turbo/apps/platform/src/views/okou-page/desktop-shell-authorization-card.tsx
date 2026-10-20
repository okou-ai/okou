import type { DesktopShellAuthorization } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Terminal, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui/components/ui/button";
import { i18n } from "../../i18n/index.ts";
import { resolvedAppLocale } from "../../i18n/format.ts";
import type { DesktopShellAuthorizationSignals } from "../../signals/chat-page/desktop-shell-authorization-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

function authorizationStatus(data: DesktopShellAuthorization): string {
  switch (data.status) {
    case "pending": {
      if (data.approvalBlockedReason === "run_unavailable") {
        return i18n.t(($) => {
          return $.desktopShellAuthorization.unavailable;
        });
      }
      return data.approvalBlockedReason === null
        ? i18n.t(($) => {
            return $.desktopShellAuthorization.pending;
          })
        : i18n.t(($) => {
            return $.desktopShellAuthorization.waiting;
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
  const deadline =
    data?.status === "approved"
      ? data.grantExpiresAt
      : data?.status === "pending"
        ? data.requestExpiresAt
        : null;
  return (
    <div className="min-h-16 text-xs text-muted-foreground" aria-live="polite">
      <p>{status}</p>
      {deadline && (
        <p>
          {t(
            ($) => {
              return $.desktopShellAuthorization.deadline;
            },
            { date: new Date(deadline).toLocaleString(resolvedAppLocale()) },
          )}
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
  loading,
}: {
  signals: DesktopShellAuthorizationSignals;
  data: DesktopShellAuthorization | null;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const refresh = useSet(signals.refresh$);
  const signal = useGet(pageSignal$);
  const [action, act] = useLoadableSet(signals.act$);
  const busy = action.state === "loading";
  const blocked =
    data?.status === "pending" && data.approvalBlockedReason !== null;
  const failed = action.state === "hasError";
  return (
    <>
      {loading && <Loader2 size={16} className="animate-spin" />}
      {data?.status === "pending" && (
        <>
          <Button
            size="sm"
            disabled={busy || blocked}
            onClick={() => {
              detach(act("approve", signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.desktopShellAuthorization.allow;
            })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              detach(act("deny", signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.desktopShellAuthorization.deny;
            })}
          </Button>
        </>
      )}
      {data?.status === "approved" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            detach(act("revoke", signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.desktopShellAuthorization.revoke;
          })}
        </Button>
      )}
      {!loading && (data === null || failed || blocked) && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            refresh();
          }}
        >
          {t(($) => {
            return $.desktopShellAuthorization.refresh;
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
    </>
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
  const ref = useSet(signals.ref$);
  const data = request.state === "hasData" ? request.data : null;
  const loading = request.state === "loading";
  return (
    <ChatCard
      ref={ref}
      data-testid="desktop-shell-authorization-card"
      className={
        standalone
          ? "flex w-full flex-col gap-3 p-4"
          : "flex h-72 w-full flex-col justify-between gap-3 p-3 @[640px]:h-64"
      }
    >
      <div className="flex min-w-0 items-start gap-3">
        <Terminal size={22} className="mt-1 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {t(($) => {
              return $.desktopShellAuthorization.title;
            })}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {data?.computerName ??
              t(($) => {
                return $.desktopShellAuthorization.scope;
              })}
          </div>
          <p
            className={
              standalone ? "mt-1 text-sm" : "mt-1 line-clamp-2 text-sm"
            }
          >
            {data?.reason ??
              t(($) => {
                return $.desktopShellAuthorization.description;
              })}
          </p>
        </div>
      </div>
      <AuthorizationStatus data={data} loading={loading} />
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        <AuthorizationActions signals={signals} data={data} loading={loading} />
        {!standalone && (
          <a
            href={signals.originalUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline"
          >
            {t(($) => {
              return $.desktopShellAuthorization.details;
            })}
          </a>
        )}
      </div>
    </ChatCard>
  );
}
