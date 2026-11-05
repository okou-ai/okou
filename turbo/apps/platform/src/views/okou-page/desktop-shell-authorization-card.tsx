import type { DesktopShellAuthorization } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Ban,
  Check,
  CircleAlert,
  Clock3,
  Loader2,
  Monitor,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  IconButton,
  cn,
} from "@okouai/ui";
import { i18n } from "../../i18n/index.ts";
import type { DesktopShellAuthorizationSignals } from "../../signals/chat-page/desktop-shell-authorization-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

type ShellAction = "approve" | "deny" | "revoke";

function authorizationTitle(
  data: DesktopShellAuthorization | null,
  loading: boolean,
): string {
  if (loading || data?.status === "pending") {
    return i18n.t(($) => {
      return $.desktopShellAuthorization.title;
    });
  }
  if (!data) {
    return i18n.t(($) => {
      return $.desktopShellAuthorization.unavailableTitle;
    });
  }
  switch (data.status) {
    case "approved": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.allowedTitle;
      });
    }
    case "denied": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.deniedTitle;
      });
    }
    case "revoked": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.revoked;
      });
    }
    case "expired": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.expiredTitle;
      });
    }
  }
}

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

function AuthorizationIcon({
  data,
  loading,
}: {
  data: DesktopShellAuthorization | null;
  loading: boolean;
}) {
  const Icon = loading
    ? Loader2
    : !data
      ? CircleAlert
      : data.status === "approved"
        ? Check
        : data.status === "expired"
          ? Clock3
          : data.status === "denied" || data.status === "revoked"
            ? Ban
            : ShieldCheck;
  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground",
        data?.status === "approved" && "text-emerald-700 dark:text-emerald-400",
      )}
    >
      <Icon
        size={22}
        aria-hidden
        className={loading ? "animate-spin" : undefined}
      />
    </div>
  );
}

function AuthorizationDetails({
  data,
  loading,
  failed,
}: {
  data: DesktopShellAuthorization | null;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const blocker = approvalBlocker(data);
  const status = data
    ? authorizationStatus(data)
    : t(($) => {
        return $.desktopShellAuthorization.unavailable;
      });
  return (
    <div className="min-w-0 space-y-5 text-sm">
      {data && (
        <div className="space-y-2 rounded-lg border border-border bg-gray-50 p-4">
          <div className="flex min-w-0 items-start gap-2 font-medium">
            <Monitor size={17} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{data.computerName}</span>
          </div>
          {(data.status === "pending" || data.status === "approved") && (
            <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <Clock3 size={14} className="mt-0.5 shrink-0" aria-hidden />
              {data.status === "pending"
                ? t(($) => {
                    return $.desktopShellAuthorization.duration;
                  })
                : t(($) => {
                    return $.desktopShellAuthorization.scope;
                  })}
            </div>
          )}
        </div>
      )}
      <div>
        <h3 className="mb-2 font-medium">
          {t(($) => {
            return $.desktopShellAuthorization.reasonTitle;
          })}
        </h3>
        <p className="break-words whitespace-pre-wrap leading-7 text-muted-foreground">
          {data?.reason ??
            t(($) => {
              return $.desktopShellAuthorization.description;
            })}
        </p>
      </div>
      {loading ? (
        <p role="status" className="text-muted-foreground">
          {t(($) => {
            return $.desktopShellAuthorization.loading;
          })}
        </p>
      ) : (
        status && (
          <p role="status" className="text-muted-foreground">
            {status}
          </p>
        )
      )}
      {blocker && (
        <p className="text-amber-700 dark:text-amber-400" aria-live="polite">
          {blocker}
        </p>
      )}
      {failed && (
        <p className="text-destructive" role="alert">
          {t(($) => {
            return $.desktopShellAuthorization.actionFailed;
          })}
        </p>
      )}
    </div>
  );
}

function AuthorizationActions({
  data,
  busy,
  failed,
  onAction,
  standalone = false,
}: {
  data: DesktopShellAuthorization | null;
  busy: boolean;
  failed: boolean;
  onAction: (action: ShellAction) => void;
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const blocked = data?.approvalBlockedReason !== null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {data?.status === "pending" ? (
        <>
          <Button
            variant="neutral"
            disabled={busy || failed}
            onClick={() => {
              return onAction("deny");
            }}
          >
            {t(($) => {
              return $.desktopShellAuthorization.deny;
            })}
          </Button>
          <Button
            pending={busy}
            disabled={blocked || failed}
            className={
              standalone
                ? "bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
                : undefined
            }
            onClick={() => {
              return onAction("approve");
            }}
          >
            {t(($) => {
              return $.desktopShellAuthorization.allow;
            })}
          </Button>
        </>
      ) : standalone ? (
        data?.status === "approved" && (
          <Button
            variant="neutral"
            pending={busy}
            disabled={failed}
            onClick={() => {
              return onAction("revoke");
            }}
          >
            {t(($) => {
              return $.desktopShellAuthorization.revoke;
            })}
          </Button>
        )
      ) : (
        <DialogClose render={<Button variant="neutral" />}>
          {t(($) => {
            return $.settings.shared.close;
          })}
        </DialogClose>
      )}
    </div>
  );
}

function AuthorizationSummary({
  data,
  loading,
  busy,
  failed,
  onAction,
}: {
  data: DesktopShellAuthorization | null;
  loading: boolean;
  busy: boolean;
  failed: boolean;
  onAction: (action: ShellAction) => void;
}) {
  const { t } = useTranslation();
  const summary = failed
    ? t(($) => {
        return $.desktopShellAuthorization.actionFailed;
      })
    : data
      ? t(
          ($) => {
            return data.status === "pending"
              ? $.desktopShellAuthorization.pendingSummary
              : data.status === "expired"
                ? $.desktopShellAuthorization.accessEnded
                : $.desktopShellAuthorization.summary;
          },
          { computer: data.computerName },
        )
      : loading
        ? t(($) => {
            return $.desktopShellAuthorization.loading;
          })
        : t(($) => {
            return $.desktopShellAuthorization.checkFailed;
          });
  return (
    <ChatCard
      data-testid="desktop-shell-authorization-card"
      aria-busy={loading || busy}
      className="flex h-[136px] w-full flex-col justify-between gap-3 px-4 py-3 @[640px]:h-[88px] @[640px]:flex-row @[640px]:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <AuthorizationIcon data={data} loading={loading} />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[0.9375rem] font-medium leading-5"
            aria-live="polite"
          >
            {authorizationTitle(data, loading)}
          </div>
          <p
            className={cn(
              "mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground",
              failed && "text-destructive",
            )}
            role={failed ? "alert" : undefined}
          >
            {summary}
          </p>
        </div>
      </div>
      <div className="ml-auto flex max-w-full shrink-0 items-center justify-end gap-1.5">
        {data?.status === "approved" && (
          <Button
            variant="quiet"
            size="sm"
            pending={busy}
            disabled={failed}
            onClick={() => {
              return onAction("revoke");
            }}
          >
            {t(($) => {
              return $.desktopShellAuthorization.revoke;
            })}
          </Button>
        )}
        {data ? (
          <DialogTrigger render={<Button variant="neutral" size="sm" />}>
            {data.status === "pending"
              ? t(($) => {
                  return $.desktopShellAuthorization.review;
                })
              : t(($) => {
                  return $.desktopShellAuthorization.details;
                })}
          </DialogTrigger>
        ) : (
          <Button variant="neutral" size="sm" disabled>
            {loading
              ? t(($) => {
                  return $.desktopShellAuthorization.loading;
                })
              : t(($) => {
                  return $.desktopShellAuthorization.unavailable;
                })}
          </Button>
        )}
      </div>
    </ChatCard>
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
  const signal = useGet(pageSignal$);
  const [action, act] = useLoadableSet(signals.act$);
  const busy = action.state === "loading";
  const failed = action.state === "hasError";
  const onAction = (next: ShellAction) => {
    detach(act(next, signal), Reason.DomCallback);
  };
  if (standalone) {
    return (
      <ChatCard
        data-testid="desktop-shell-authorization-card"
        className="w-full space-y-5 p-6"
      >
        <div className="flex items-center gap-3">
          <AuthorizationIcon data={data} loading={loading} />
          <h1 className="text-lg font-medium">
            {authorizationTitle(data, loading)}
          </h1>
        </div>
        <AuthorizationDetails data={data} loading={loading} failed={failed} />
        <AuthorizationActions
          data={data}
          busy={busy}
          failed={failed}
          onAction={onAction}
          standalone
        />
      </ChatCard>
    );
  }
  return (
    <Dialog>
      <AuthorizationSummary
        data={data}
        loading={loading}
        busy={busy}
        failed={failed}
        onAction={onAction}
      />
      <DialogContent
        maxWidth={560}
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground">
            <Terminal size={22} aria-hidden />
          </div>
          <DialogTitle className="min-w-0 flex-1 font-medium leading-6">
            {t(($) => {
              return $.desktopShellAuthorization.title;
            })}
          </DialogTitle>
          <DialogClose
            render={
              <IconButton
                className="shrink-0"
                aria-label={t(($) => {
                  return $.settings.shared.close;
                })}
              />
            }
          >
            <X size={20} />
          </DialogClose>
        </DialogHeader>
        <AuthorizationDetails data={data} loading={loading} failed={failed} />
        <AuthorizationActions
          data={data}
          busy={busy}
          failed={failed}
          onAction={onAction}
        />
      </DialogContent>
    </Dialog>
  );
}
