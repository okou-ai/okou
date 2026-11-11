import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@okouai/ui";
import type { SshAuthorization } from "@okouai/api-contracts/contracts/ssh-authorization";
import type { SshAuthorizationSignals } from "../../signals/chat-page/ssh-authorization-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

type SshAction = "approve" | "deny" | "revoke";

function SshAuthorizationDetails({ data }: { data: SshAuthorization }) {
  const { t } = useTranslation();
  const blocker = data.approvalBlockedReason;
  return (
    <>
      {blocker && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.sshAuthorization.blocked[blocker];
          })}
        </p>
      )}
      <div className="min-w-0 text-sm">
        <p className="truncate font-medium">{data.displayName}</p>
        <p className="break-all text-muted-foreground">
          {data.username}@{data.host}:{data.port}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.sshAuthorization.effect;
          })}
        </p>
      </div>
      <p className="break-words whitespace-pre-wrap text-sm leading-5 text-muted-foreground">
        {data.reason}
      </p>
      {blocker === "permissions_required" && (
        <ul className="text-xs text-muted-foreground">
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

function SshAuthorizationActions({
  data,
  busy,
  onAction,
}: {
  data: SshAuthorization;
  busy: boolean;
  onAction: (action: SshAction) => void;
}) {
  const { t } = useTranslation();
  const canApprove =
    data.status === "pending" ||
    (data.status === "approved" && data.continuationPending);
  return (
    <>
      {data.status === "pending" && (
        <Button
          variant="neutral"
          size="sm"
          disabled={busy}
          onClick={() => {
            onAction("deny");
          }}
        >
          {t(($) => {
            return $.desktopShellAuthorization.deny;
          })}
        </Button>
      )}
      {canApprove && (
        <Button
          size="sm"
          pending={busy}
          disabled={busy || data.approvalBlockedReason !== null}
          className="bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
          onClick={() => {
            onAction("approve");
          }}
        >
          {data.status === "approved"
            ? t(($) => {
                return $.sshAuthorization.continue;
              })
            : t(($) => {
                return $.sshAuthorization.allow;
              })}
        </Button>
      )}
      {data.status === "approved" && (
        <Button
          variant="quiet"
          size="sm"
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

export function SshAuthorizationCard({
  signals,
}: {
  signals: SshAuthorizationSignals;
}) {
  const { t } = useTranslation();
  const request = useLastLoadable(signals.request$);
  const [operation, act] = useLoadableSet(signals.act$);
  const signal = useGet(pageSignal$);
  const refresh = useSet(signals.refresh$);
  const data = request.state === "hasData" ? request.data : null;
  const loading = request.state === "loading";
  const busy = operation.state === "loading";
  const failed = operation.state === "hasError" || request.state === "hasError";
  const action = (value: SshAction) => {
    detach(act(value, signal), Reason.DomCallback);
  };
  return (
    <ChatCard
      data-testid="ssh-authorization-card"
      aria-busy={loading || busy}
      className="flex h-80 w-full flex-col gap-3 px-4 py-3"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground">
          {loading ? (
            <Loader2 size={22} className="animate-spin" aria-hidden />
          ) : data?.status === "approved" ? (
            <Check size={22} aria-hidden />
          ) : (
            <ShieldCheck size={22} aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[0.9375rem] font-medium leading-5"
            aria-live="polite"
          >
            {data
              ? t(($) => {
                  return $.sshAuthorization.status[data.status];
                })
              : t(($) => {
                  return $.sshAuthorization.title;
                })}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(($) => {
              return $.sshAuthorization.scope;
            })}
          </p>
        </div>
      </div>
      <div
        role="region"
        aria-label={t(($) => {
          return $.desktopShellAuthorization.reasonTitle;
        })}
        tabIndex={0}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain"
      >
        {data ? (
          <SshAuthorizationDetails data={data} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {loading
              ? t(($) => {
                  return $.desktopShellAuthorization.loading;
                })
              : t(($) => {
                  return $.sshAuthorization.unavailable;
                })}
          </p>
        )}
      </div>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.sshAuthorization.failed;
          })}
        </p>
      )}
      <div className="mt-auto flex shrink-0 flex-wrap justify-end gap-2">
        {!data && !loading && (
          <Button
            variant="neutral"
            size="sm"
            onClick={() => {
              refresh();
            }}
          >
            {t(($) => {
              return $.sshAuthorization.retry;
            })}
          </Button>
        )}
        {data && (
          <SshAuthorizationActions data={data} busy={busy} onAction={action} />
        )}
      </div>
    </ChatCard>
  );
}
