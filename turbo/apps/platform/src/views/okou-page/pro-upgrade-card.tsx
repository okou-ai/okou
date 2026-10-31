import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../i18n/format.ts";
import { ChatCard } from "./components/chat-card.tsx";

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
      className="@container w-full max-w-2xl overflow-hidden text-left"
    >
      <div className="px-4 py-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.chat.billing.proCard.title;
          })}
        </h3>
        <p className="mt-0.5 text-xs leading-4.5 text-muted-foreground">
          {t(($) => {
            return $.chat.billing.proCard.description;
          })}
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t border-border/50 bg-gray-50 px-4 py-3 @[480px]:flex-row @[480px]:flex-wrap @[480px]:items-center @[480px]:justify-between @[480px]:gap-4">
        <div className="grid min-h-7 min-w-0 text-xs text-brand-text">
          {/* Keep the offer's space while the price catalog is loading. */}
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
          {monthlyPriceUsd === undefined && (
            <p className="self-center text-muted-foreground [grid-area:1/1]">
              {t(($) => {
                return $.chat.billing.proCard.priceUnavailable;
              })}
            </p>
          )}
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
          className="h-auto min-h-9 w-full max-w-full shrink-0 px-3 py-2 whitespace-normal @[480px]:ml-auto @[480px]:w-auto @[480px]:px-4"
        >
          {monthlyPriceUsd !== undefined
            ? t(
                ($) => {
                  return $.chat.billing.proCard.upgradeFromPrice;
                },
                { price: formatUsd(monthlyPriceUsd, 0) },
              )
            : t(($) => {
                return $.chat.billing.proCard.upgradeNow;
              })}
        </Button>
      </div>
    </ChatCard>
  );
}
