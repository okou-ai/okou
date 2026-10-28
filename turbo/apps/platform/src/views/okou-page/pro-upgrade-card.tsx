import { Button } from "@okouai/ui";
import { ArrowRight, Check, Gift } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../i18n/format.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { proUpgradeFigureImg } from "./platform-assets.ts";

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
    t(
      ($) => {
        return $.billing.plans.highlights.concurrentAgents;
      },
      { slots: 3 },
    ),
    t(($) => {
      return $.billing.plans.highlights.automations;
    }),
    t(($) => {
      return $.billing.plans.highlights.builtInResearchData;
    }),
  ];

  return (
    <ChatCard
      data-testid="plan-upgrade-card"
      className="flex w-full flex-col overflow-hidden text-left @[480px]:flex-row"
    >
      <div
        aria-hidden="true"
        className="flex shrink-0 items-end justify-center bg-illustration-canvas px-4 pt-5 @[480px]:w-1/3 @[480px]:items-center @[480px]:py-6"
      >
        {/* Frame the pointing figure from the existing onboarding artwork. */}
        <div className="relative h-28 w-24 overflow-hidden @[480px]:h-52 @[480px]:w-44 @[640px]:h-64 @[640px]:w-52">
          <img
            src={proUpgradeFigureImg}
            alt=""
            className="absolute bottom-0 left-0 h-40 w-auto max-w-none @[480px]:h-72 @[640px]:h-[22rem]"
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 p-5 @[640px]:p-7">
        <div className="space-y-2">
          {remainingTasks !== undefined && (
            <p className="text-sm font-medium text-muted-foreground">
              {remainingTasks === 0
                ? t(($) => {
                    return $.chat.billing.proCard.noTasksLeft;
                  })
                : t(
                    ($) => {
                      return $.chat.billing.proCard.tasksLeft;
                    },
                    {
                      count: remainingTasks,
                    },
                  )}
            </p>
          )}
          <h3 className="text-xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.chat.billing.proCard.title;
            })}
          </h3>
        </div>

        <ul className="space-y-2 text-sm leading-5 text-muted-foreground">
          {benefits.map((benefit) => {
            return (
              <li key={benefit} className="flex items-start gap-2">
                <Check
                  aria-hidden="true"
                  size={16}
                  className="mt-0.5 shrink-0 text-foreground"
                />
                <span>{benefit}</span>
              </li>
            );
          })}
        </ul>

        {bonusCredits !== undefined && bonusCredits > 0 && (
          <p className="flex items-start gap-2 text-sm font-medium leading-5 text-foreground">
            <Gift aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
            <span>
              {t(
                ($) => {
                  return $.chat.billing.proCard.upgradeBonus;
                },
                {
                  credits: formatLocalizedNumber(bonusCredits),
                },
              )}
            </span>
          </p>
        )}

        <div className="mt-auto flex flex-col items-start gap-3">
          <p className="flex min-h-8 flex-wrap items-baseline gap-1 text-sm text-muted-foreground">
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
          <Button
            type="button"
            size="lg"
            onClick={onUpgrade}
            className="w-full bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed @[480px]:w-auto"
          >
            {t(($) => {
              return $.chat.billing.upgradeToPro;
            })}
            <ArrowRight aria-hidden="true" size={16} />
          </Button>
        </div>
      </div>
    </ChatCard>
  );
}
