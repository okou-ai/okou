import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { subscriptionResetPageSignals$ } from "../../signals/subscription-reset/subscription-reset-page-state.ts";
import { SubscriptionResetCard } from "../okou-page/subscription-reset-card.tsx";

export function SubscriptionResetPage() {
  const { t } = useTranslation();
  const signals = useGet(subscriptionResetPageSignals$);
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-8">
      {signals ? (
        <SubscriptionResetCard signals={signals} />
      ) : (
        <p role="alert">
          {t(($) => {
            return $.chat.subscriptionReset.unavailable;
          })}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.subscriptionReset.confirmation;
        })}
      </p>
    </main>
  );
}
