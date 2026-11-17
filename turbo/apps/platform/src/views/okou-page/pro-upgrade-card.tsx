import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../i18n/format.ts";
import { ChatNoticeCard } from "./components/chat-notice-card.tsx";

interface ProUpgradeCardProps {
  readonly onUpgrade: () => void;
  readonly monthlyPriceUsd?: number;
  readonly includedCredits?: number;
  readonly bonusCredits?: number;
}

/** Price and offer data replace bounded rows without resizing the transcript. */
export function ProUpgradeCard({
  onUpgrade,
  monthlyPriceUsd,
  includedCredits,
  bonusCredits,
}: ProUpgradeCardProps) {
  const { t } = useTranslation();
  const action =
    monthlyPriceUsd !== undefined
      ? t(
          ($) => {
            return $.chat.billing.proCard.upgradeFromPrice;
          },
          { price: formatUsd(monthlyPriceUsd, 0) },
        )
      : t(($) => {
          return $.chat.billing.proCard.upgradeNow;
        });
  return (
    <ChatNoticeCard
      size="offer"
      data-testid="plan-upgrade-card"
      className="flex max-w-2xl flex-col text-left"
    >
      <div className="h-16 min-w-0 shrink-0 px-4 py-2.5">
        <h3 className="h-6 truncate text-base font-semibold leading-6 tracking-tight text-foreground">
          {t(($) => {
            return $.chat.billing.proCard.title;
          })}
        </h3>
        <p className="mt-0.5 h-5 truncate text-xs leading-5 text-muted-foreground">
          {t(($) => {
            return $.chat.billing.proCard.description;
          })}
        </p>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-between gap-2 rounded-b-[var(--okou-chat-card-radius)] border-t border-border/50 bg-gray-50 px-4 py-3 @[640px]:flex-row @[640px]:items-center">
        <div className="h-7 min-w-0 truncate text-xs leading-7 text-brand-text @[640px]:flex-1">
          {monthlyPriceUsd === undefined ? (
            <span className="text-muted-foreground">
              {t(($) => {
                return $.chat.billing.proCard.priceUnavailable;
              })}
            </span>
          ) : bonusCredits !== undefined && bonusCredits > 0 ? (
            <>
              {includedCredits !== undefined && (
                <strong className="text-xl font-semibold tracking-tight text-foreground">
                  {formatLocalizedNumber(includedCredits)}
                </strong>
              )}{" "}
              <strong className="text-xl font-semibold tracking-tight">
                {formatLocalizedNumber(bonusCredits, { signDisplay: "always" })}
              </strong>{" "}
              <span>
                {t(($) => {
                  return $.chat.billing.proCard.creditsNow;
                })}
              </span>
            </>
          ) : null}
        </div>
        <Button
          type="button"
          variant="default"
          size="default"
          onClick={onUpgrade}
          title={action}
          className="h-9 w-full shrink-0 whitespace-nowrap px-3 @[640px]:w-auto @[640px]:max-w-[60%]"
        >
          <span className="min-w-0 truncate">{action}</span>
        </Button>
      </div>
    </ChatNoticeCard>
  );
}
