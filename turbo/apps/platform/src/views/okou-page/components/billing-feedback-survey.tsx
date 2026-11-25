import { Check, X } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  IconButton,
  Popover,
  PopoverContent,
  Radio,
  RadioGroup,
  Textarea,
  cn,
} from "@okouai/ui";
import {
  billingFeedbackSession$,
  billingFeedbackOtherSelected$,
  billingFeedbackCanSubmit$,
  markBillingFeedbackShown$,
  selectBillingFeedbackChoice$,
  setBillingFeedbackOtherText$,
  submitBillingFeedback$,
  closeBillingFeedback$,
} from "../../../signals/billing-feedback.ts";

// This unanchored feedback prompt keeps the SDK's lower-right placement.
function feedbackAnchor() {
  return {
    getBoundingClientRect() {
      return new DOMRect(window.innerWidth - 24, window.innerHeight - 24, 0, 0);
    },
  };
}

export function BillingFeedbackSurvey() {
  const session = useGet(billingFeedbackSession$);
  const markShown = useSet(markBillingFeedbackShown$);
  const close = useSet(closeBillingFeedback$);
  const { t } = useTranslation();
  if (!session) {
    return null;
  }
  const { question, survey, submitted } = session;
  const title = submitted
    ? (survey.appearance?.thankYouMessageHeader ??
      t(($) => {
        return $.billing.feedback.thanks;
      }))
    : question.question;
  const description = submitted
    ? survey.appearance?.thankYouMessageDescription
    : question.description;
  const closeLabel = t(($) => {
    return $.actions.close;
  });
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <PopoverContent
        ref={markShown}
        anchor={feedbackAnchor}
        side="top"
        align="end"
        sideOffset={0}
        collisionPadding={24}
        // An unsolicited prompt must not steal focus from the chat composer.
        initialFocus={false}
        aria-labelledby="billing-feedback-title"
        aria-describedby={
          description ? "billing-feedback-description" : undefined
        }
        className="relative w-[360px] max-w-[var(--available-width)] max-h-[var(--available-height)] overflow-y-auto rounded-2xl border-surface-border p-6 shadow-sm"
      >
        <IconButton
          aria-label={closeLabel}
          showTooltip={false}
          onClick={close}
          className="absolute right-2 top-2 size-7 text-muted-foreground"
        >
          <X size={16} />
        </IconButton>
        {submitted && (
          <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-nested-fill text-brand-text">
            <Check size={20} />
          </div>
        )}
        <h2
          id="billing-feedback-title"
          className="pr-4 text-lg font-semibold leading-snug"
        >
          {title}
        </h2>
        {description && (
          <p
            id="billing-feedback-description"
            className="mt-2 text-sm leading-relaxed text-muted-foreground"
          >
            {description}
          </p>
        )}
        {submitted ? (
          <Button className="mt-5 w-full" onClick={close}>
            {survey.appearance?.thankYouMessageCloseButtonText ?? closeLabel}
          </Button>
        ) : (
          <BillingFeedbackForm />
        )}
      </PopoverContent>
    </Popover>
  );
}

function BillingFeedbackForm() {
  const session = useGet(billingFeedbackSession$);
  const otherSelected = useGet(billingFeedbackOtherSelected$);
  const canSubmit = useGet(billingFeedbackCanSubmit$);
  const selectChoice = useSet(selectBillingFeedbackChoice$);
  const setOtherText = useSet(setBillingFeedbackOtherText$);
  const submit = useSet(submitBillingFeedback$);
  const { t } = useTranslation();
  if (!session) {
    return null;
  }
  const { question } = session;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="mt-5 space-y-4"
    >
      <RadioGroup
        aria-labelledby="billing-feedback-title"
        value={session.choice}
        onValueChange={(value) => {
          if (typeof value === "number") {
            selectChoice(value);
          }
        }}
        className="overflow-hidden rounded-lg border border-surface-border"
      >
        {question.choices.map((choice, index) => {
          return (
            <label
              key={choice}
              className={cn(
                "flex cursor-default items-center gap-3 px-3 py-2.5 text-sm leading-relaxed hover:bg-nested-fill",
                index > 0 && "border-t border-t-gray-400",
                session.choice === index && "bg-nested-fill",
              )}
            >
              <Radio value={index} />
              <span>{choice}</span>
            </label>
          );
        })}
      </RadioGroup>
      {otherSelected && (
        <Textarea
          aria-label={question.choices.at(-1)}
          placeholder={t(($) => {
            return $.billing.feedback.otherPlaceholder;
          })}
          value={session.otherText}
          onChange={(event) => {
            setOtherText(event.target.value);
          }}
          rows={3}
          maxLength={1000}
          className="resize-y"
        />
      )}
      <Button type="submit" disabled={!canSubmit} className="w-full">
        {t(($) => {
          return $.billing.feedback.submitFeedback;
        })}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        {t(($) => {
          return $.billing.feedback.rewardTerms;
        })}
      </p>
    </form>
  );
}
