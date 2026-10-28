import { Badge, Button } from "@okouai/ui";
import { Check } from "lucide-react";
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
  const benefits = [
    t(($) => {
      return $.chat.billing.proCard.parallelTasks;
    }),
    t(($) => {
      return $.chat.billing.proCard.automations;
    }),
    t(($) => {
      return $.chat.billing.proCard.research;
    }),
  ];

  return (
    <ChatCard
      data-testid="plan-upgrade-card"
      className="flex w-full flex-col overflow-hidden text-left @[560px]:flex-row"
    >
      <div
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center bg-illustration-canvas px-4 py-5 @[560px]:w-2/5"
      >
        <img
          src={proUpgradeSceneImg}
          alt=""
          className="h-32 w-full object-contain @[560px]:h-auto"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center p-5 @[640px]:p-7">
        <div>
          <h3 className="text-xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.chat.billing.proCard.title;
            })}
          </h3>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm leading-5 text-foreground">
            {benefits.map((benefit) => {
              return (
                <li key={benefit} className="flex items-center gap-1.5">
                  <Check
                    aria-hidden="true"
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span>{benefit}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="mt-4 flex items-center gap-3 @[640px]:gap-5">
          <p className="flex min-w-0 flex-wrap items-baseline gap-1 text-xs text-muted-foreground @[640px]:text-sm">
            {monthlyPriceUsd !== undefined ? (
              <>
                {t(($) => {
                  return $.billing.plans.usagePacks.priceFrom;
                })}
                <span className="text-3xl font-semibold tracking-tight text-foreground @[640px]:text-4xl">
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
            <Badge className="min-w-0 flex-col items-start gap-0.5 border-primary/20 bg-primary/10 px-2 py-2 text-brand-text @[640px]:px-3">
              <span className="text-xs font-medium">
                {t(($) => {
                  return $.chat.billing.proCard.upgradeToday;
                })}
              </span>
              <span className="flex flex-wrap items-baseline gap-1 text-xs font-medium @[640px]:text-sm">
                <strong className="text-2xl font-semibold tracking-tight @[640px]:text-3xl">
                  {formatLocalizedNumber(bonusCredits, {
                    signDisplay: "always",
                  })}
                </strong>
                {t(($) => {
                  return $.chat.billing.proCard.bonusCreditsLabel;
                })}
              </span>
            </Badge>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="lg"
            onClick={onUpgrade}
            className="shrink-0 bg-foreground px-4 text-background hover:bg-foreground-hover active:bg-foreground-pressed"
          >
            {t(($) => {
              return $.chat.billing.proCard.upgradeNow;
            })}
          </Button>
          {remainingTasks !== undefined && (
            <p className="text-xs text-muted-foreground">
              {remainingTasks === 0
                ? t(($) => {
                    return $.chat.billing.proCard.noTasksLeft;
                  })
                : t(
                    ($) => {
                      return $.chat.billing.proCard.tasksLeft;
                    },
                    { count: remainingTasks },
                  )}
            </p>
          )}
        </div>
      </div>
    </ChatCard>
  );
}
