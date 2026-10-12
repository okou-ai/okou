import { surfaceVariants } from "@okouai/ui";
import { Button } from "@okouai/ui/components/ui/button";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  debugMorningBriefEmailEnabled$,
  debugMorningBriefEmailResponse$,
  refreshDebugMorningBriefEmail$,
  sendDebugMorningBriefEmail$,
} from "../../../../signals/okou-page/settings/debug-morning-brief-email.ts";
import { settingsActionSignal$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { detach, isAbortError, Reason } from "../../../../signals/utils.ts";

export function MorningBriefTestEmailCard() {
  const { t } = useTranslation();
  const enabled = useLoadable(debugMorningBriefEmailEnabled$);
  const receipt = useLoadable(debugMorningBriefEmailResponse$);
  const [sending, send] = useLoadableSet(sendDebugMorningBriefEmail$);
  const [refreshing, refresh] = useLoadableSet(refreshDebugMorningBriefEmail$);
  const signal = useGet(settingsActionSignal$);
  if (enabled.state !== "hasData" || !enabled.data) {
    return null;
  }
  const response = receipt.state === "hasData" ? receipt.data : null;
  const pending = sending.state === "loading" || refreshing.state === "loading";
  const error = sending.state === "hasError" ? sending.error : undefined;
  const statuses = {
    queued: t(($) => {
      return $.settings.preferences.debug.morningBriefEmail.status.queued;
    }),
    sent: t(($) => {
      return $.settings.preferences.debug.morningBriefEmail.status.sent;
    }),
  };
  const reasons = {
    unsubscribed: t(($) => {
      return $.settings.preferences.debug.morningBriefEmail.reasons
        .unsubscribed;
    }),
    suppressed: t(($) => {
      return $.settings.preferences.debug.morningBriefEmail.reasons.suppressed;
    }),
    "no-email": t(($) => {
      return $.settings.preferences.debug.morningBriefEmail.reasons["no-email"];
    }),
    expired: t(($) => {
      return $.settings.preferences.debug.morningBriefEmail.reasons.expired;
    }),
    "delivery-failed": t(($) => {
      return $.settings.preferences.debug.morningBriefEmail.reasons[
        "delivery-failed"
      ];
    }),
  };

  return (
    <section
      aria-labelledby="morning-brief-test-email-title"
      className={surfaceVariants({
        radius: "compact",
        className: "flex flex-col gap-3 p-4",
      })}
    >
      <div className="flex flex-wrap items-center gap-4">
        <Mail size={22} className="shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3
            id="morning-brief-test-email-title"
            className="text-sm font-medium text-foreground"
          >
            {t(($) => {
              return $.settings.preferences.debug.morningBriefEmail.title;
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.debug.morningBriefEmail.description;
            })}
          </p>
        </div>
        <Button
          type="button"
          disabled={pending || !signal || response?.status === "queued"}
          onClick={() => {
            if (signal) {
              detach(send(signal), Reason.DomCallback);
            }
          }}
        >
          {sending.state === "loading"
            ? t(($) => {
                return $.settings.preferences.debug.morningBriefEmail.sending;
              })
            : response
              ? t(($) => {
                  return $.settings.preferences.debug.morningBriefEmail
                    .sendAnother;
                })
              : error
                ? t(($) => {
                    return $.settings.preferences.debug.morningBriefEmail.retry;
                  })
                : t(($) => {
                    return $.settings.preferences.debug.morningBriefEmail.send;
                  })}
        </Button>
      </div>
      {response && (
        <p role="status" className="text-sm text-muted-foreground">
          {response.status === "skipped" || response.status === "failed"
            ? reasons[response.reason]
            : statuses[response.status]}
        </p>
      )}
      {response?.status === "queued" && (
        <div>
          <Button
            type="button"
            variant="neutral"
            disabled={pending || !signal}
            onClick={() => {
              if (signal) {
                detach(refresh(signal), Reason.DomCallback);
              }
            }}
          >
            {t(($) => {
              return $.settings.preferences.debug.morningBriefEmail.checkStatus;
            })}
          </Button>
        </div>
      )}
      {error !== undefined && !isAbortError(error) && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.preferences.debug.morningBriefEmail.requestFailed;
          })}
        </p>
      )}
    </section>
  );
}
