import type { FormEvent } from "react";
import { useLastResolved, useSet, useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { Input } from "@okouai/ui/components/ui/input";
import { Radio, RadioGroup } from "@okouai/ui/components/ui/radio";

import { formatLocalizedNumber } from "../../../i18n/format.ts";
import {
  abandonedCheckoutSurvey$,
  CHECKOUT_ABANDONED_SURVEY_ANSWERS,
  CREDITS_EXHAUSTED_SURVEY_ANSWERS,
  checkoutAbandonedDraft$,
  creditsExhaustedDraft$,
  creditsExhaustedSurveyReward$,
  creditsExhaustedThanks$,
  dismissCheckoutAbandonedSurvey$,
  submitCheckoutAbandonedSurvey$,
  submitCreditsExhaustedSurvey$,
  updateCheckoutAbandonedDraft$,
  updateCreditsExhaustedDraft$,
  type CheckoutAbandonedSurveyAnswer,
  type CreditsExhaustedSurveyAnswer,
} from "../../../signals/billing-survey.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { detach, Reason } from "../../../signals/utils.ts";

interface SurveyOptionsProps<Answer extends string> {
  readonly name: string;
  readonly answers: readonly Answer[];
  readonly selected: Answer | null;
  readonly detail: string;
  readonly disabled: boolean;
  readonly label: (answer: Answer) => string;
  readonly onSelect: (answer: Answer) => void;
  readonly onDetailChange: (detail: string) => void;
}

function SurveyOptions<Answer extends string>({
  name,
  answers,
  selected,
  detail,
  disabled,
  label,
  onSelect,
  onDetailChange,
}: SurveyOptionsProps<Answer>) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        name={name}
        value={selected ?? ""}
        disabled={disabled}
        onValueChange={(value) => {
          const answer = answers.find((candidate) => {
            return candidate === value;
          });
          if (answer) {
            onSelect(answer);
          }
        }}
        className="flex flex-col gap-1"
      >
        {answers.map((answer) => {
          return (
            <label
              key={answer}
              className="flex min-h-8 items-center gap-2.5 rounded-md px-1 text-sm text-foreground"
            >
              <Radio value={answer} />
              <span className="min-w-0 break-words">{label(answer)}</span>
            </label>
          );
        })}
      </RadioGroup>
      {selected === "other" ? (
        <Input
          value={detail}
          maxLength={500}
          disabled={disabled}
          aria-label={t(($) => {
            return $.billing.survey.otherLabel;
          })}
          placeholder={t(($) => {
            return $.billing.survey.otherPlaceholder;
          })}
          onChange={(event) => {
            onDetailChange(event.currentTarget.value);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The upgrade question under the out-of-credits card's upgrade action. It
 * renders nothing until the member is known to be eligible, and stays as a
 * short thank-you line after the answer is sent.
 */
export function CreditsExhaustedSurvey() {
  const { t } = useTranslation();
  const reward = useLastResolved(creditsExhaustedSurveyReward$);
  const thanks = useGet(creditsExhaustedThanks$);
  const draft = useGet(creditsExhaustedDraft$);
  const updateDraft = useSet(updateCreditsExhaustedDraft$);
  const [submitLoadable, submit] = useLoadableSet(
    submitCreditsExhaustedSurvey$,
  );
  const pageSignal = useGet(pageSignal$);
  const submitting = submitLoadable.state === "loading";

  if (thanks) {
    return (
      <p
        role="status"
        className="border-t border-border px-3 py-2.5 text-sm leading-5 text-muted-foreground"
      >
        {thanks.rewardCredits > 0
          ? t(
              ($) => {
                return $.billing.survey.creditsExhausted.thanksWithCredits;
              },
              { credits: formatLocalizedNumber(thanks.rewardCredits) },
            )
          : t(($) => {
              return $.billing.survey.thanks;
            })}
      </p>
    );
  }
  if (reward === undefined || reward === null) {
    return null;
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    // The form owns submission; the page stays in place.
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback);
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={t(($) => {
        return $.billing.survey.creditsExhausted.question;
      })}
      className="flex flex-col gap-2 border-t border-border p-3"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.survey.creditsExhausted.question;
          })}
        </p>
        {reward > 0 ? (
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
            {t(
              ($) => {
                return $.billing.survey.creditsExhausted.reward;
              },
              { credits: formatLocalizedNumber(reward) },
            )}
          </p>
        ) : null}
      </div>
      <SurveyOptions<CreditsExhaustedSurveyAnswer>
        name="credits-exhausted-survey"
        answers={CREDITS_EXHAUSTED_SURVEY_ANSWERS}
        selected={draft.answer}
        detail={draft.detail}
        disabled={submitting}
        label={(answer) => {
          return t(($) => {
            return $.billing.survey.creditsExhausted.answers[answer];
          });
        }}
        onSelect={(answer) => {
          updateDraft({ answer });
        }}
        onDetailChange={(detail) => {
          updateDraft({ detail });
        }}
      />
      {submitLoadable.state === "hasError" ? (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.billing.survey.error;
          })}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={draft.answer === null || submitting}
          className={cn("disabled:opacity-60")}
        >
          {t(($) => {
            return $.billing.survey.submit;
          })}
        </Button>
      </div>
    </form>
  );
}

/**
 * Asks once why a hosted Checkout was left without paying: right after Stripe's
 * back link, or on the next visit when the Checkout tab was simply closed.
 */
export function CheckoutAbandonedSurveyDialog() {
  const { t } = useTranslation();
  const survey = useLastResolved(abandonedCheckoutSurvey$);
  const draft = useGet(checkoutAbandonedDraft$);
  const updateDraft = useSet(updateCheckoutAbandonedDraft$);
  const [dismissLoadable, dismiss] = useLoadableSet(
    dismissCheckoutAbandonedSurvey$,
  );
  const [submitLoadable, submit] = useLoadableSet(
    submitCheckoutAbandonedSurvey$,
  );
  const pageSignal = useGet(pageSignal$);
  const submitting =
    submitLoadable.state === "loading" || dismissLoadable.state === "loading";

  if (!survey) {
    return null;
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    // The form owns submission; the page stays in place.
    event.preventDefault();
    detach(
      submit(survey.checkoutKind, survey.checkoutSessionId, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) {
          detach(
            dismiss(survey.checkoutSessionId, pageSignal),
            Reason.DomCallback,
          );
        }
      }}
    >
      <DialogContent maxWidth="md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {t(($) => {
                return $.billing.survey.checkoutAbandoned.question;
              })}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.billing.survey.checkoutAbandoned.description;
              })}
            </DialogDescription>
          </DialogHeader>
          <SurveyOptions<CheckoutAbandonedSurveyAnswer>
            name="checkout-abandoned-survey"
            answers={CHECKOUT_ABANDONED_SURVEY_ANSWERS}
            selected={draft.answer}
            detail={draft.detail}
            disabled={submitting}
            label={(answer) => {
              return t(($) => {
                return $.billing.survey.checkoutAbandoned.answers[answer];
              });
            }}
            onSelect={(answer) => {
              updateDraft({ answer });
            }}
            onDetailChange={(detail) => {
              updateDraft({ detail });
            }}
          />
          {submitLoadable.state === "hasError" ||
          dismissLoadable.state === "hasError" ? (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.billing.survey.error;
              })}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                detach(
                  dismiss(survey.checkoutSessionId, pageSignal),
                  Reason.DomCallback,
                );
              }}
            >
              {t(($) => {
                return $.billing.survey.notNow;
              })}
            </Button>
            <Button
              type="submit"
              disabled={draft.answer === null || submitting}
            >
              {t(($) => {
                return $.billing.survey.submit;
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
