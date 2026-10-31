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
        className="flex w-16 items-center justify-center p-2 @[480px]:row-span-2 @[480px]:w-24 @[480px]:bg-illustration-canvas @[480px]:p-3"
      >
        <img
          src={proUpgradeSceneImg}
          alt=""
          className="h-12 w-full object-contain @[480px]:h-20"
        />
      </div>

      <div className="min-w-0 px-4 pt-3">
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
      <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 pt-2 pb-3 @[480px]:col-span-1 @[480px]:col-start-2 @[640px]:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] @[640px]:gap-x-2">
        <div className="col-start-1 row-start-2 grid min-h-10 min-w-0 items-center text-xs text-muted-foreground @[640px]:row-start-1">
          <p
            aria-hidden="true"
            className="invisible flex flex-wrap items-baseline gap-1 [grid-area:1/1]"
          >
            {t(($) => {
              return $.billing.plans.usagePacks.priceFrom;
            })}
            <span className="inline-block w-12 text-2xl">&nbsp;</span>
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
        <div className="col-span-2 row-start-1 grid min-w-0 text-sm font-medium text-brand-text @[640px]:col-span-1 @[640px]:col-start-2">
          <p
            aria-hidden="true"
            className="invisible flex flex-wrap items-baseline gap-x-1.5 [grid-area:1/1]"
          >
            <span className="inline-flex items-baseline gap-1.5">
              <span className="inline-block w-16 text-xl">&nbsp;</span>
              <span className="inline-block w-14 text-xl">&nbsp;</span>
            </span>
            <span className="whitespace-nowrap">
              {t(($) => {
                return $.chat.billing.proCard.creditsNow;
              })}
            </span>
          </p>
          {bonusCredits !== undefined && bonusCredits > 0 && (
            <p className="flex flex-wrap items-baseline gap-x-1.5 [grid-area:1/1]">
              <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
                {includedCredits !== undefined && (
                  <strong className="text-xl font-semibold tracking-tight text-foreground">
                    {formatLocalizedNumber(includedCredits)}
                  </strong>
                )}{" "}
                <strong className="text-xl font-semibold tracking-tight">
                  {formatLocalizedNumber(bonusCredits, {
                    signDisplay: "always",
                  })}
                </strong>
              </span>{" "}
              <span className="whitespace-nowrap">
                {t(($) => {
                  return $.chat.billing.proCard.creditsNow;
                })}
              </span>
            </p>
          )}
        </div>

        <Button
          type="button"
          variant="default"
          size="default"
          onClick={onUpgrade}
          className="col-start-2 row-start-2 shrink-0 @[640px]:col-start-3 @[640px]:row-start-1"
        >
          {t(($) => {
            return $.chat.billing.proCard.upgradeNow;
          })}
        </Button>
      </div>
    </ChatCard>
  );
}
