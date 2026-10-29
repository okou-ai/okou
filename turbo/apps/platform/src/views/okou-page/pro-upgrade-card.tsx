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
  // The introductory upgrade offer shown by the calling surface.
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
      className="grid w-full max-w-2xl grid-cols-[auto_minmax(0,1fr)] overflow-hidden text-left"
    >
      <div
        aria-hidden="true"
        className="flex w-20 items-center justify-center p-2 @[480px]:row-span-2 @[480px]:w-28 @[480px]:bg-illustration-canvas @[480px]:p-3"
      >
        <img
          src={proUpgradeSceneImg}
          alt=""
          className="h-12 w-full object-contain @[480px]:h-20"
        />
      </div>

      <div className="min-w-0 p-3 pb-0">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
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
        <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
          {t(($) => {
            return $.chat.billing.proCard.description;
          })}
        </p>
      </div>

      <div className="col-span-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-3 pt-2 @[480px]:col-span-1 @[480px]:col-start-2">
        <p className="order-1 flex min-w-0 flex-wrap items-baseline gap-1 text-sm text-muted-foreground">
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
          <p className="order-3 basis-full text-sm font-medium text-brand-text @[480px]:order-2 @[480px]:basis-auto">
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

        <Button
          type="button"
          variant="default"
          size="default"
          onClick={onUpgrade}
          className="order-2 shrink-0 @[480px]:order-3"
        >
          {t(($) => {
            return $.chat.billing.proCard.upgradeNow;
          })}
        </Button>
      </div>
    </ChatCard>
  );
}
