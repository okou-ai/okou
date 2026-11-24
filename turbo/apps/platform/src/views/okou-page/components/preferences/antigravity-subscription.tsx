import { Button } from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  antigravitySubscription$,
  changeAntigravitySubscription$,
  refreshAntigravitySubscription$,
} from "../../../../signals/okou-page/settings/antigravity-subscription.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export function AntigravitySubscription() {
  const { t } = useTranslation();
  const current = useLoadable(antigravitySubscription$);
  const refresh = useSet(refreshAntigravitySubscription$);
  const [operation, change] = useLoadableSet(changeAntigravitySubscription$);
  const signal = useGet(pageSignal$);
  if (current.state !== "hasData" || !current.data) {
    return null;
  }
  const { enabled, profile } = current.data;
  const busy = operation.state === "loading";
  return (
    <section
      aria-label={t(($) => {
        return $.settings.models.antigravity.title;
      })}
      className="flex flex-col items-start gap-3 rounded-xl border border-surface-border bg-card p-4"
    >
      <h3 className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.settings.models.antigravity.title;
        })}
      </h3>
      {profile.status === "unassigned" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.antigravity.unassigned;
          })}
        </p>
      )}
      {profile.status === "connected" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.personal.status.connected;
          })}
        </p>
      )}
      {enabled &&
        (profile.status === "pending" || profile.status === "connected") && (
          <>
            <p className="text-sm text-muted-foreground">
              {profile.status === "pending"
                ? t(($) => {
                    return $.settings.models.antigravity.terminal;
                  })
                : t(($) => {
                    return $.settings.models.antigravity.verify;
                  })}
            </p>
            <code className="max-w-full select-all break-all rounded-md bg-muted px-2 py-1 text-xs">
              {profile.status === "pending"
                ? `ssh -t -- ${profile.loginHost} ${profile.bindingId}`
                : `ssh -t -- ${profile.loginHost} verify ${profile.bindingId}`}
            </code>
          </>
        )}
      {profile.status === "expired" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.antigravity.expired;
          })}
        </p>
      )}
      {(operation.state === "hasError" || profile.status === "unavailable") && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.models.antigravity.error;
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {enabled &&
          (profile.status === "disconnected" ||
            profile.status === "expired") && (
            <Button
              size="sm"
              variant="neutral"
              disabled={busy}
              onClick={() => {
                detach(change("connect", signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.settings.models.personal.connectAccount;
              })}
            </Button>
          )}
        {enabled && profile.status === "pending" && (
          <Button
            size="sm"
            variant="neutral"
            disabled={busy}
            onClick={() => {
              refresh();
            }}
          >
            {t(($) => {
              return $.settings.models.antigravity.check;
            })}
          </Button>
        )}
        {profile.status !== "disconnected" &&
          profile.status !== "unassigned" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                detach(
                  change({ disconnect: profile.bindingId }, signal),
                  Reason.DomCallback,
                );
              }}
            >
              {t(($) => {
                return $.settings.models.personal.disconnectAccount;
              })}
            </Button>
          )}
      </div>
    </section>
  );
}
