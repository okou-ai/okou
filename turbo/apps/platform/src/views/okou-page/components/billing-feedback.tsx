import { MessageSquare } from "lucide-react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Button } from "@okouai/ui";
import {
  creditsFeedbackOffer$,
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
  const request = useSet(requestCreditsFeedback$);
  const signal = useGet(pageSignal$);
  const { t } = useTranslation();
  if (!eligible || !offer) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => {
        detach(request(signal), Reason.DomCallback);
      }}
    >
      <MessageSquare size={16} />
      {t(($) => {
        return $.billing.feedback.earnExtraCredits;
      })}
    </Button>
  );
}
