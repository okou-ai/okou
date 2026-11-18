import type { FormEvent } from "react";
import { MessageSquare } from "lucide-react";
import { useLastResolved, useSet, useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@okouai/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@okouai/ui/components/ui/dialog";
import { Input } from "@okouai/ui/components/ui/input";
import { Radio, RadioGroup } from "@okouai/ui/components/ui/radio";

import { formatLocalizedNumber } from "../../../i18n/format.ts";
import {
  abandonedCheckoutSurvey$,
  CHECKOUT_ABANDONED_SURVEY_ANSWERS,
  CREDITS_EXHAUSTED_SURVEY_ANSWERS,
  checkoutAbandonedDraft$,
  checkoutAbandonedSurveyReady$,
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
  readonly question: string;
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
  question,
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
        aria-label={question}
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
        className="-mx-3 flex flex-col gap-1"
      >
        {answers.map((answer) => {
          return (
            <label
              key={answer}
              className={cn(
                "flex min-h-10 cursor-default items-center gap-3 rounded-lg px-3 py-2 text-sm leading-5 text-foreground transition-colors has-data-disabled:cursor-not-allowed",
                !disabled &&
                  "[&:hover]:bg-state-hover-overlay [&:active]:bg-state-pressed-overlay",
                selected === answer && "bg-nested-fill",
              )}
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

/** Keep asynchronous eligibility and the survey form inside a fixed action slot. */
export function CreditsExhaustedSurvey({
  eligible,
}: {
  readonly eligible: boolean;
}) {
  const { t } = useTranslation();
  const reward = useLastResolved(creditsExhaustedSurveyReward$);
  const thanks = useGet(creditsExhaustedThanks$);
  if ((!eligible || reward === undefined || reward === null) && !thanks) {
    return null;
  }
  const title = t(($) => {
    return $.billing.survey.creditsExhausted.question;
  });
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={title}
            title={title}
            className="shrink-0"
          >
            <MessageSquare size={16} />
          </Button>
        }
      />
      <DialogContent
        maxWidth="md"
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <CreditsExhaustedSurveyContent />
      </DialogContent>
    </Dialog>
  );
}

function CreditsExhaustedSurveyContent() {
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
  const question = t(($) => {
    return $.billing.survey.creditsExhausted.question;
  });

  if (thanks) {
    return (
      <>
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="leading-snug">{question}</DialogTitle>
          <DialogDescription role="status">
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
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t(($) => {
              return $.settings.shared.close;
            })}
          </DialogClose>
        </DialogFooter>
      </>
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
      aria-label={question}
      className="flex flex-col gap-5"
    >
      <DialogHeader className="pr-8 text-left">
        <DialogTitle className="leading-snug">{question}</DialogTitle>
        {reward > 0 ? (
          <DialogDescription>
            {t(
              ($) => {
                return $.billing.survey.creditsExhausted.reward;
              },
              { credits: formatLocalizedNumber(reward) },
            )}
          </DialogDescription>
        ) : null}
      </DialogHeader>
      <SurveyOptions<CreditsExhaustedSurveyAnswer>
        name="credits-exhausted-survey"
        question={question}
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
      <DialogFooter>
        <DialogClose
          render={
            <Button type="button" variant="outline" disabled={submitting} />
          }
        >
          {t(($) => {
            return $.billing.survey.notNow;
          })}
        </DialogClose>
        <Button
          type="submit"
          pending={submitting}
          disabled={draft.answer === null}
        >
          {t(($) => {
            return $.billing.survey.submit;
          })}
        </Button>
      </DialogFooter>
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
  const ready = useGet(checkoutAbandonedSurveyReady$);
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

  if (!survey || !ready) {
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
      <DialogContent
        maxWidth="md"
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <DialogHeader className="pr-8 text-left">
            <DialogTitle className="leading-snug">
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
            question={t(($) => {
              return $.billing.survey.checkoutAbandoned.question;
            })}
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
              variant="outline"
              pending={dismissLoadable.state === "loading"}
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
              pending={submitLoadable.state === "loading"}
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
