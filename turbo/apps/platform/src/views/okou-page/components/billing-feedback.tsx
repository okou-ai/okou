import { MessageSquare } from "lucide-react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Button } from "@okouai/ui";
import {
  creditsFeedbackOffer$,
  creditsFeedbackSurveyAvailable$,
  requestCreditsFeedback$,
} from "../../../signals/billing-feedback.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { useTranslation } from "react-i18next";

export function CreditsFeedbackButton({
  eligible,
}: {
  readonly eligible: boolean;
}) {
  const offer = useLastResolved(creditsFeedbackOffer$);
  const available = useGet(creditsFeedbackSurveyAvailable$);
  const request = useSet(requestCreditsFeedback$);
  const signal = useGet(pageSignal$);
  const { t } = useTranslation();
  if (!eligible || !available || !offer) {
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
        detach(request(signal), Reason.DomCallback);
      }}
    >
      <MessageSquare size={16} />
    </Button>
  );
}
