import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../i18n/format.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { proUpgradeSceneImg } from "./platform-assets.ts";

interface ProUpgradeCardProps {
  readonly onUpgrade: () => void;
  readonly monthlyPriceUsd?: number;
  // Only supply these when a trusted quota/campaign source confirms them.
  readonly remainingTasks?: number;
  readonly bonusCredits?: number;
}

/** The same upgrade surface can carry an eligible onboarding offer. */
export function ProUpgradeCard({
  onUpgrade,
  monthlyPriceUsd,
  remainingTasks,
  bonusCredits,
}: ProUpgradeCardProps) {
  const { t } = useTranslation();
  return (
    <ChatCard
      data-testid="plan-upgrade-card"
      className="flex w-full flex-col overflow-hidden text-left @[560px]:flex-row"
    >
      <div
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center bg-illustration-canvas px-5 py-5 @[560px]:w-1/3"
      >
        <img
          src={proUpgradeSceneImg}
          alt=""
          className="h-32 w-full object-contain @[560px]:h-auto"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center p-5 @[640px]:p-7">
        <div>
          <h3 className="text-xl font-semibold tracking-tight text-foreground @[640px]:text-2xl">
            {remainingTasks === undefined
              ? t(($) => {
                  return $.chat.billing.proCard.title;
                })
              : remainingTasks === 0
                ? t(($) => {
                    return $.chat.billing.proCard.noTasksLeft;
                  })
                : t(
                    ($) => {
                      return $.chat.billing.proCard.tasksLeft;
                    },
                    { count: remainingTasks },
                  )}
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t(($) => {
              return $.chat.billing.proCard.description;
            })}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <p className="flex shrink-0 items-baseline gap-1 text-sm text-muted-foreground">
            {monthlyPriceUsd !== undefined ? (
              <>
                {t(($) => {
                  return $.billing.plans.usagePacks.priceFrom;
                })}
                <span className="text-3xl font-semibold tracking-tight text-foreground">
                  {formatUsd(monthlyPriceUsd, 0)}
                </span>
                {t(($) => {
                  return $.billing.plans.perMonth;
                })}
              </>
            ) : (
              t(($) => {
                return $.chat.billing.proCard.priceUnavailable;
              })
            )}
          </p>
          {bonusCredits !== undefined && bonusCredits > 0 && (
            <p className="text-sm font-medium text-brand-text">
              <strong className="text-xl font-semibold tracking-tight">
                {formatLocalizedNumber(bonusCredits, {
                  signDisplay: "always",
                })}
              </strong>{" "}
              {t(($) => {
                return $.chat.billing.proCard.bonusCreditsNow;
              })}
            </p>
          )}
        </div>

        <Button
          type="button"
          variant="default"
          size="default"
          onClick={onUpgrade}
          className="mt-5 self-start"
        >
          {t(($) => {
            return $.chat.billing.proCard.upgradeNow;
          })}
        </Button>
      </div>
    </ChatCard>
  );
}
