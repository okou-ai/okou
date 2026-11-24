import { MessageSquare } from "lucide-react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Button } from "@okouai/ui";
import {
  billingFeedbackRef$,
  creditsFeedbackOffer$,
} from "../../../signals/billing-feedback.ts";
import {
  pendingBillingFeedback$,
  requestBillingFeedback$,
} from "../../../signals/billing-feedback-flow.ts";
import { settingsDialogSessionActive$ } from "../../../signals/okou-page/settings/settings-dialog.ts";
import { useTranslation } from "react-i18next";

export function CreditsFeedbackButton({
  eligible,
}: {
  readonly eligible: boolean;
}) {
  const offer = useLastResolved(creditsFeedbackOffer$);
  const request = useSet(requestBillingFeedback$);
  const { t } = useTranslation();
  if (!eligible || !offer) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      className="shrink-0"
      aria-label={t(($) => {
        return $.billing.feedback.shareFeedback;
      })}
      onClick={() => {
        request("credits_exhausted");
      }}
    >
      <MessageSquare size={16} />
    </Button>
  );
}

/** Defer native popovers until the owning settings surface has finished closing. */
export function BillingFeedback() {
  const request = useGet(pendingBillingFeedback$);
  const settingsActive = useGet(settingsDialogSessionActive$);
  const ref = useSet(billingFeedbackRef$);
  return request && !settingsActive ? (
    <span key={request.id} className="hidden" ref={ref} />
  ) : null;
}
