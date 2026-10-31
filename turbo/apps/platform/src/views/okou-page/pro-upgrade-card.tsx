import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../i18n/format.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { proUpgradeSceneImg } from "./platform-assets.ts";

interface ProUpgradeCardProps {
  readonly onUpgrade: () => void;
  readonly monthlyPriceUsd?: number;
  readonly includedCredits?: number;
  // The introductory upgrade offer shown by the calling surface.
  readonly bonusCredits?: number;
}

/** The same upgrade surface can carry an eligible onboarding offer. */
export function ProUpgradeCard({
  onUpgrade,
  monthlyPriceUsd,
  includedCredits,
  bonusCredits,
}: ProUpgradeCardProps) {
  const { t } = useTranslation();
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

      <div className="min-w-0 p-4 pb-0">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.chat.billing.proCard.title;
          })}
        </h3>
        <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
          {t(($) => {
            return $.chat.billing.proCard.description;
          })}
        </p>
      </div>

      {/* Reserve localized price and credit geometry before the catalog loads. */}
      <div className="col-span-2 grid min-w-0 gap-3 p-4 pt-3 @[480px]:col-span-1 @[480px]:col-start-2 @[640px]:grid-cols-[minmax(0,1fr)_auto] @[640px]:items-end @[640px]:gap-x-4">
        <div className="grid min-w-0 gap-1 text-sm text-muted-foreground">
          <div className="grid min-w-0 items-center">
            <p
              aria-hidden="true"
              className="invisible flex flex-wrap items-baseline gap-1 [grid-area:1/1]"
            >
              {t(($) => {
                return $.billing.plans.usagePacks.priceFrom;
              })}
              <span className="inline-block w-28 text-2xl">&nbsp;</span>
              {t(($) => {
                return $.billing.plans.perMonth;
              })}
            </p>
            <p aria-hidden="true" className="invisible [grid-area:1/1]">
              {t(($) => {
                return $.chat.billing.proCard.priceUnavailable;
              })}
            </p>
            <p className="flex min-w-0 flex-wrap items-baseline gap-1 [grid-area:1/1]">
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
          </div>
          <div className="grid min-w-0">
            <p aria-hidden="true" className="invisible [grid-area:1/1]">
              {t(
                ($) => {
                  return $.billing.plans.usagePacks.totalCreditsWithBonus;
                },
                {
                  credits: formatLocalizedNumber(100_000),
                  bonus: formatLocalizedNumber(10_000, {
                    signDisplay: "always",
                  }),
                },
              )}
            </p>
            {includedCredits !== undefined && (
              <p className="[grid-area:1/1]">
                {bonusCredits !== undefined && bonusCredits > 0
                  ? t(
                      ($) => {
                        return $.billing.plans.usagePacks.totalCreditsWithBonus;
                      },
                      {
                        credits: formatLocalizedNumber(includedCredits),
                        bonus: formatLocalizedNumber(bonusCredits, {
                          signDisplay: "always",
                        }),
                      },
                    )
                  : t(
                      ($) => {
                        return $.billing.plans.usagePacks.packCredits;
                      },
                      { credits: formatLocalizedNumber(includedCredits) },
                    )}
              </p>
            )}
          </div>
        </div>

        <Button
          type="button"
          variant="default"
          size="default"
          onClick={onUpgrade}
          className="w-full shrink-0 @[640px]:w-auto"
        >
          {t(($) => {
            return $.chat.billing.proCard.upgradeNow;
          })}
        </Button>
      </div>
    </ChatCard>
  );
}
