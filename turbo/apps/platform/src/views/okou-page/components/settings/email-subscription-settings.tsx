import type { EmailSubscriptionResponse } from "@okouai/api-contracts/contracts/email-subscription";
import { Button } from "@okouai/ui/components/ui/button";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, Mail, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  emailSubscription$,
  retryEmailSubscription$,
  updateEmailSubscription$,
} from "../../../../signals/okou-page/settings/email-subscription.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

function EmailSubscriptionStatus({
  preference,
  failed,
}: {
  readonly preference: EmailSubscriptionResponse | undefined;
  readonly failed: boolean;
}) {
  const { t } = useTranslation();
  const unavailable =
    preference !== undefined && preference.deliveryStatus !== "available";
  let status: string | null = null;
  if (failed) {
    status = t(($) => {
      return $.settings.preferences.emailSubscription.retryMessage;
    });
  } else if (unavailable) {
    status = t(($) => {
      return $.settings.preferences.emailSubscription.unavailable;
    });
  }
  if (status === null) {
    return null;
  }
  return (
    <div
      className="flex flex-col gap-1 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <div className="flex items-center gap-1.5">
        {(failed || unavailable) && (
          <AlertCircle className="size-3.5 shrink-0" />
        )}
        <span>{status}</span>
      </div>
      {unavailable && !failed && (
        <span>
          {t(($) => {
            return $.settings.preferences.emailSubscription
              .unavailableDescription;
          })}
        </span>
      )}
    </div>
  );
}

export function EmailSubscriptionSettings() {
  const { t } = useTranslation();
  const loadable = useLoadable(emailSubscription$);
  const preference = useLastResolved(emailSubscription$);
  const [mutation, update] = useLoadableSet(updateEmailSubscription$);
  const reload = useSet(retryEmailSubscription$);
  const pageSignal = useGet(pageSignal$);
  const loading = loadable.state === "loading";
  const saving = mutation.state === "loading";
  const loadFailed = loadable.state === "hasError";
  const saveFailed = mutation.state === "hasError";
  const handleToggle = (subscribed: boolean) => {
    detach(update(subscribed, pageSignal), Reason.DomCallback);
  };
  const handleRetry = () => {
    if (saveFailed && preference && !loadFailed) {
      handleToggle(!preference.subscribed);
    } else {
      reload();
    }
  };

  const description = preference?.email
    ? t(
        ($) => {
          return $.settings.preferences.emailSubscription.descriptionWithEmail;
        },
        { email: preference.email },
      )
    : t(($) => {
        return $.settings.preferences.emailSubscription.description;
      });

  return (
    <PreferenceCardRow
      icon={Mail}
      grouped
      iconContainerClassName="h-10 w-10 rounded-xl bg-gray-50"
      title={t(($) => {
        return $.settings.preferences.emailSubscription.title;
      })}
      description={description}
      status={
        <EmailSubscriptionStatus
          preference={preference}
          failed={loadFailed || saveFailed}
        />
      }
    >
      <div className="flex shrink-0 items-center gap-2">
        {(loadFailed || saveFailed) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRetry}
            disabled={loading || saving}
          >
            <RotateCcw />
            {t(($) => {
              return $.settings.preferences.morningBrief.retry;
            })}
          </Button>
        )}
        {preference ? (
          <Switch
            aria-label={t(($) => {
              return $.settings.preferences.emailSubscription.title;
            })}
            checked={preference.subscribed}
            disabled={loading || saving || loadFailed}
            onCheckedChange={handleToggle}
          />
        ) : (
          <div className="h-6 w-11 rounded-full bg-muted" aria-hidden="true" />
        )}
      </div>
    </PreferenceCardRow>
  );
}
