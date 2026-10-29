import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../i18n/format.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { proUpgradeSceneImg } from "./platform-assets.ts";

interface ProUpgradeCardProps {
  readonly onUpgrade: () => void;
  readonly monthlyPriceUsd?: number;
  // Supply a positive estimate bound derived from credits and typical task usage.
  readonly estimatedTasksUpperBound?: number;
  // Only supply when a trusted campaign source confirms eligibility.
  readonly bonusCredits?: number;
}

/** The same upgrade surface can carry an eligible onboarding offer. */
export function ProUpgradeCard({
  onUpgrade,
  monthlyPriceUsd,
  estimatedTasksUpperBound,
  bonusCredits,
}: ProUpgradeCardProps) {
  const { t } = useTranslation();
  const hasTaskEstimate =
    estimatedTasksUpperBound !== undefined && estimatedTasksUpperBound > 0;
  return (
    <ChatCard
      data-testid="plan-upgrade-card"
      className="flex w-full max-w-2xl overflow-hidden text-left"
    >
      <div
        aria-hidden="true"
        className="flex w-20 shrink-0 items-center justify-center bg-illustration-canvas p-2 @[480px]:w-32 @[480px]:p-3"
      >
        <img
          src={proUpgradeSceneImg}
          alt=""
          className="h-24 w-full object-contain @[480px]:h-28"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center p-3 @[480px]:p-4">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-foreground @[480px]:text-lg">
            {hasTaskEstimate
              ? t(
                  ($) => {
                    return $.chat.billing.proCard.estimatedTasksLeft;
                  },
                  { count: estimatedTasksUpperBound },
                )
              : t(($) => {
                  return $.chat.billing.proCard.title;
                })}
          </h3>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t(($) => {
              return $.chat.billing.proCard.description;
            })}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex min-w-0 flex-wrap items-baseline gap-1 text-sm text-muted-foreground">
              {monthlyPriceUsd !== undefined ? (
                <>
                  {t(($) => {
                    return $.billing.plans.usagePacks.priceFrom;
                  })}
                  <span className="text-2xl font-semibold tracking-tight text-foreground">
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
            className="shrink-0"
          >
            {t(($) => {
              return $.chat.billing.proCard.upgradeNow;
            })}
          </Button>
        </div>
      </div>
    </ChatCard>
  );
}
