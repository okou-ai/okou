import type { DesktopShellAuthorization } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Check, Terminal, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@okouai/ui";
import { i18n } from "../../i18n/index.ts";
import type { DesktopShellAuthorizationSignals } from "../../signals/chat-page/desktop-shell-authorization-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { ChatCardDetails } from "./components/chat-card-details.tsx";

function authorizationStatus(data: DesktopShellAuthorization): string | null {
  switch (data.status) {
    case "pending": {
      return null;
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
      return data.approvedAt === null
        ? i18n.t(($) => {
            return $.desktopShellAuthorization.requestExpired;
          })
        : i18n.t(($) => {
            return $.desktopShellAuthorization.expired;
          });
    }
  }
}

function approvalBlocker(
  data: DesktopShellAuthorization | null,
): string | null {
  if (data?.status !== "pending") {
    return null;
  }
  switch (data.approvalBlockedReason) {
    case null: {
      return null;
    }
    case "run_active": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.blocked.runActive;
      });
    }
    case "run_unavailable": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.blocked.runUnavailable;
      });
    }
    case "chat_busy": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.blocked.chatBusy;
      });
    }
    case "computer_changed": {
      return i18n.t(
        ($) => {
          return $.desktopShellAuthorization.blocked.computerChanged;
        },
        { computer: data.computerName },
      );
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
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs font-medium text-muted-foreground",
        data?.status === "approved" && "text-emerald-700 dark:text-emerald-400",
      )}
      aria-live="polite"
    >
      {loading ? <Loader2 size={14} className="shrink-0 animate-spin" /> : null}
      {data?.status === "approved" ? (
        <Check size={14} className="shrink-0" aria-hidden />
      ) : null}
      {status}
    </span>
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
  const signal = useGet(pageSignal$);
  const [action, act] = useLoadableSet(signals.act$);
  const busy = action.state === "loading";
  const blocked =
    data?.status === "pending" && data.approvalBlockedReason !== null;
  const failed = action.state === "hasError";
  return (
    <div className="col-span-2 row-start-3 ml-auto flex min-h-8 max-w-full flex-wrap items-center justify-end gap-2 @[640px]:col-span-1 @[640px]:col-start-3 @[640px]:row-start-1">
      <AuthorizationStatus data={data} loading={loading} />
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
  const request = useLastLoadable(signals.request$);
  const data = request.state === "hasData" ? request.data : null;
  const loading = request.state === "loading";
  const blocker = approvalBlocker(data);
  const reason =
    data?.reason ??
    t(($) => {
      return $.desktopShellAuthorization.description;
    });
  const viewReason = t(($) => {
    return $.desktopShellAuthorization.viewReason;
  });
  return (
    <ChatCard
      data-testid="desktop-shell-authorization-card"
      className={cn(
        "grid w-full grid-cols-[40px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-2 p-3 @[640px]:grid-cols-[40px_minmax(0,1fr)_auto] @[640px]:grid-rows-[auto_minmax(0,1fr)] @[640px]:p-4",
        !standalone && "h-48 @[640px]:h-32",
      )}
    >
      <div className="col-start-1 row-start-1 flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-gray-50">
        <Terminal size={22} aria-hidden />
      </div>
      <div className="col-start-2 row-start-1 min-w-0 self-center">
        <div className="truncate text-[0.9375rem] font-medium leading-5">
          {t(($) => {
            return $.desktopShellAuthorization.title;
          })}
        </div>
        {data && (
          <div className="mt-0.5 truncate text-sm leading-5 text-muted-foreground">
            {data.computerName}
          </div>
        )}
      </div>
      <div className="col-span-2 row-start-2 min-h-0 min-w-0 overflow-y-auto @[640px]:col-start-2">
        {standalone || !data ? (
          <p className="text-sm leading-5 break-words whitespace-pre-wrap">
            {reason}
          </p>
        ) : (
          <ChatCardDetails
            title={t(($) => {
              return $.desktopShellAuthorization.reasonTitle;
            })}
            triggerLabel={viewReason}
            trigger={
              <Button
                variant="quiet"
                className="flex h-auto w-full min-w-0 justify-start px-0 py-0 text-left font-normal whitespace-normal text-foreground"
                aria-label={viewReason}
                showTooltip
              >
                <span
                  className={cn(
                    "text-sm leading-5 break-words whitespace-pre-wrap",
                    blocker
                      ? "line-clamp-1"
                      : "line-clamp-3 @[640px]:line-clamp-2",
                  )}
                >
                  {reason}
                </span>
              </Button>
            }
          >
            <p className="text-foreground whitespace-pre-wrap">{reason}</p>
          </ChatCardDetails>
        )}
        {blocker && (
          <p
            className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-400"
            aria-live="polite"
          >
            {blocker}
          </p>
        )}
      </div>
      <AuthorizationActions signals={signals} data={data} loading={loading} />
    </ChatCard>
  );
}
