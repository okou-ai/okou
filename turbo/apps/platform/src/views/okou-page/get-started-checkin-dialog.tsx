import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import {
  checkinConfirmation$,
  checkinConfirmationFinalFocus$,
  closeCheckinConfirmation$,
  getStartedSummary$,
} from "../../signals/okou-page/get-started.ts";
import { QuestFigure } from "./get-started-quest-shell.tsx";

/** The receipt outlives the menu and any subsequent reward-status refresh. */
export function GetStartedCheckinDialog() {
  const { t } = useTranslation();
  const confirmation = useGet(checkinConfirmation$);
  const close = useSet(closeCheckinConfirmation$);
  const finalFocus = useSet(checkinConfirmationFinalFocus$);
  const summary = useLoadable(getStartedSummary$);
  if (!confirmation) {
    return null;
  }

  return (
    <Dialog
      open={confirmation.open}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent smMaxWidth={680} finalFocus={finalFocus}>
        <div className="-m-6 flex min-h-72 items-stretch">
          <div className="hidden sm:contents">
            <QuestFigure art="checkinWeek" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-6">
            <DialogHeader>
              <DialogTitle className="pr-7">
                {t(($) => {
                  return $.chat.homePage.getStarted.intro.checkin.title;
                })}
              </DialogTitle>
              <div className="min-h-5 text-sm text-muted-foreground">
                {summary.state === "hasData" &&
                  summary.data.checkinStreak > 0 &&
                  t(
                    ($) => {
                      return $.chat.homePage.getStarted.streak;
                    },
                    {
                      amount: formatLocalizedNumber(summary.data.checkinStreak),
                    },
                  )}
              </div>
            </DialogHeader>
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-brand-text">
              {t(
                ($) => {
                  return $.chat.homePage.getStarted.intro.checkin.amount;
                },
                {
                  amount: formatLocalizedNumber(
                    confirmation.claim.rewardAmount,
                  ),
                },
              )}
            </p>
            <DialogDescription>
              {t(($) => {
                return $.chat.homePage.getStarted.intro.checkin.description;
              })}
            </DialogDescription>
            <DialogFooter className="mt-auto">
              <DialogClose render={<Button type="button" />}>
                {t(($) => {
                  return $.chat.homePage.getStarted.intro.checkin.confirm;
                })}
              </DialogClose>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
