import type { EmailSubscriptionResponse } from "@okouai/api-contracts/contracts/email-subscription";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLastResolved, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  emailSubscription$,
  updateEmailSubscription$,
} from "../../../../signals/okou-page/settings/email-subscription.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

function EmailSubscriptionStatus({
  preference,
}: {
  readonly preference: EmailSubscriptionResponse | undefined;
}) {
  const { t } = useTranslation();
  if (preference === undefined || preference.deliveryStatus === "available") {
    return null;
  }
  return (
    <div
      className="flex flex-col gap-1 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <div className="flex items-center gap-1.5">
        <AlertCircle className="size-3.5 shrink-0" />
        <span>
          {t(($) => {
            return $.settings.preferences.emailSubscription.unavailable;
          })}
        </span>
      </div>
      <span>
        {t(($) => {
          return $.settings.preferences.emailSubscription
            .unavailableDescription;
        })}
      </span>
    </div>
  );
}

export function EmailSubscriptionSettings() {
  const { t } = useTranslation();
  const loadable = useLoadable(emailSubscription$);
  const preference = useLastResolved(emailSubscription$);
  const [mutation, update] = useLoadableSet(updateEmailSubscription$);
  const pageSignal = useGet(pageSignal$);
  const loading = loadable.state === "loading";
  const saving = mutation.state === "loading";
  const loadFailed = loadable.state === "hasError";
  const handleToggle = (subscribed: boolean) => {
    detach(update(subscribed, pageSignal), Reason.DomCallback);
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
      status={<EmailSubscriptionStatus preference={preference} />}
    >
      <div className="flex shrink-0 items-center gap-2">
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
