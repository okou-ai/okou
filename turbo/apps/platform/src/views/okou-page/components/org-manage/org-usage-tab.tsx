import { useLoadable } from "ccstate-react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { OrgMember } from "@okouai/api-contracts/contracts/org-members";
import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";
import type { MemberUsage } from "@okouai/api-contracts/contracts/usage";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { billingStatusAsync$ } from "../../../../signals/okou-page/billing.ts";
import { orgPlanCapabilitiesFromBilling } from "../../../../signals/okou-page/org-plan-capabilities.ts";
import { currentLocale, i18n } from "../../../../i18n/index.ts";
import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import { now } from "../../../../lib/time.ts";
import { UserAvatar } from "../../../components/avatar.tsx";
import { UsageBreakdownBar } from "../usage-breakdown-bar.tsx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function displayName(m: OrgMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "";
}

// ---------------------------------------------------------------------------
// Credit breakdown bar chart
// ---------------------------------------------------------------------------

type CreditSegment = BillingStatusResponse["creditBreakdown"][number];

// Segment swatches map to theme tokens defined in
// `turbo/apps/platform/src/views/css/index.css` under `@theme`. Keep the
// mapping here purely symbolic so branding/dark-mode tweaks happen in CSS.
// Pay as you go shares Usage's "other" yellow so the charts stay consistent.
const CATEGORY_COLORS: Readonly<
  Record<Exclude<CreditSegment["category"], "plan">, string>
> = {
  free: "bg-credit-free",
  promotional: "bg-credit-promotional",
  payAsYouGo: "bg-usage-kind-other",
};

const PLAN_COLORS: Readonly<
  Record<NonNullable<CreditSegment["tier"]>, string>
> = {
  pro: "bg-credit-plan-pro",
  team: "bg-credit-plan-team",
};

function colorForSegment(seg: CreditSegment): string {
  if (seg.category === "plan") {
    return seg.tier ? PLAN_COLORS[seg.tier] : "bg-credit-plan-pro";
  }
  return CATEGORY_COLORS[seg.category];
}

function segmentKey(seg: CreditSegment): string {
  // `buildCreditBreakdown` keys segments by `category:tier`, so the same
  // composite is stable and unique across the array.
  return seg.tier ? `${seg.category}:${seg.tier}` : seg.category;
}

type CreditGrant = BillingStatusResponse["creditGrants"][number];

export interface CreditAddition {
  readonly id: string;
  readonly label: string;
  readonly amount: number;
  readonly remaining: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly neverExpires?: boolean;
}

function descriptionForSegment(
  seg: CreditSegment,
  currentTier: string,
): string {
  if (seg.category === "free") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.freeDescription;
    });
  }
  if (seg.category === "promotional") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.promotionalDescription;
    });
  }
  if (seg.category === "payAsYouGo") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.payAsYouGoDescription;
    });
  }
  if (seg.tier === currentTier) {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.currentPlanDescription;
    });
  }
  return i18n.t(($) => {
    return $.billing.usage.breakdown.previousPlanDescription;
  });
}

function labelForSegment(seg: CreditSegment): string {
  if (currentLocale() === "en-US") {
    return seg.label;
  }
  if (seg.category === "plan") {
    return seg.tier === "team"
      ? i18n.t(($) => {
          return $.billing.usage.breakdown.teamPlan;
        })
      : i18n.t(($) => {
          return $.billing.usage.breakdown.proPlan;
        });
  }
  if (seg.category === "free") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.freePlan;
    });
  }
  if (seg.category === "promotional") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.promotional;
    });
  }
  return i18n.t(($) => {
    return $.billing.usage.breakdown.payAsYouGo;
  });
}

export function formatCreditDate(value: string): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

// Grants that never expire are stored with a sentinel far-future date, and not
// every source flags them. Anything a century out is a sentinel, not a date a
// reader needs.
const NEVER_EXPIRES_AFTER_MS = 100 * 365 * 24 * 60 * 60 * 1000;

function neverExpires(grant: CreditAddition): boolean {
  if (grant.neverExpires) {
    return true;
  }
  const expiresAt = new Date(grant.expiresAt).getTime();
  return !Number.isNaN(expiresAt) && expiresAt - now() > NEVER_EXPIRES_AFTER_MS;
}

function expiresLabel(grant: CreditAddition): string {
  if (neverExpires(grant)) {
    return i18n.t(($) => {
      return $.billing.usage.neverExpires;
    });
  }
  return i18n.t(
    ($) => {
      return $.billing.usage.expires;
    },
    { date: formatCreditDate(grant.expiresAt) },
  );
}

// Every credit addition row shares this three-column grid, so credits and the
// remaining balance keep one right edge across the header and rows.
const GRANT_ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem] sm:gap-x-4";

export function CreditAdditionTable({
  grants,
  showHeading = true,
  testIdPrefix = "credit-grants",
}: {
  grants: readonly CreditAddition[];
  showHeading?: boolean;
  testIdPrefix?: string;
}) {
  const { t } = useTranslation();
  if (grants.length === 0) {
    return null;
  }

  return (
    <div
      data-testid={`${testIdPrefix}-section`}
      className={showHeading ? "mt-4 pt-3" : undefined}
    >
      {showHeading ? (
        <p className="text-sm font-semibold text-foreground">
          {t(($) => {
            return $.billing.usage.creditAdditions;
          })}
        </p>
      ) : null}
      <div
        className={`${GRANT_ROW_GRID} pb-2 pt-2.5 text-[13px] text-muted-foreground`}
      >
        <span>
          {t(($) => {
            return $.billing.usage.grantsTable.date;
          })}
        </span>
        <span className="text-right">
          {t(($) => {
            return $.billing.usage.grantsTable.credits;
          })}
        </span>
        <span className="text-right">
          {t(($) => {
            return $.billing.usage.grantsTable.left;
          })}
        </span>
      </div>
      <TooltipProvider delay={100}>
        {grants.map((grant) => {
          return (
            <Tooltip key={grant.id}>
              <TooltipTrigger
                render={
                  <div
                    tabIndex={0}
                    data-testid={`${testIdPrefix}-${grant.id}`}
                    className={`${GRANT_ROW_GRID} cursor-default border-t border-border/50 py-2.5 outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
                  >
                    <span className="whitespace-nowrap text-[13px] text-foreground">
                      {formatCreditDate(grant.createdAt)}
                    </span>
                    <span className="text-right text-[13px] font-semibold tabular-nums text-foreground">
                      {`+${formatLocalizedNumber(grant.amount)}`}
                    </span>
                    <span className="text-right text-[13px] tabular-nums text-muted-foreground">
                      {formatLocalizedNumber(grant.remaining)}
                    </span>
                  </div>
                }
              />
              <TooltipContent
                side="top"
                sideOffset={8}
                className="border shadow-md bg-popover! text-popover-foreground!"
              >
                <div className="font-medium text-foreground">{grant.label}</div>
                <div className="mt-0.5 text-muted-foreground">
                  {expiresLabel(grant)}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </TooltipProvider>
    </div>
  );
}

function OrgCreditHeader({ total }: { total: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-between gap-3 items-baseline">
      <p className="text-sm font-semibold text-foreground">
        {t(($) => {
          return $.billing.usage.orgCredits;
        })}
      </p>
      <p className="text-xl font-medium tabular-nums text-foreground">
        {formatLocalizedNumber(total)}
      </p>
    </div>
  );
}

/** The composition of the balance, separated into credit sources. */
function CreditBreakdownBar({
  segments,
  tier,
  total,
}: {
  segments: readonly CreditSegment[];
  tier: string;
  total: number;
}) {
  if (total <= 0 || segments.length === 0) {
    return null;
  }
  return (
    <TooltipProvider delay={100}>
      <div className="mt-4 flex h-2 w-full gap-[3px]">
        {segments.map((s) => {
          const color = colorForSegment(s);
          const desc = descriptionForSegment(s, tier);
          return (
            <Tooltip key={segmentKey(s)}>
              <TooltipTrigger
                render={
                  <div
                    data-testid={`credit-balance-segment-${segmentKey(s)}`}
                    className={`h-2 first:rounded-l-full last:rounded-r-full ${color} cursor-default ring-0 hover:ring-2 hover:ring-foreground/30 hover:z-10 transition-shadow`}
                    style={{
                      width: `${(s.credits / total) * 100}%`,
                    }}
                  />
                }
              />
              <TooltipContent
                side="top"
                sideOffset={8}
                className="border shadow-md bg-popover! text-popover-foreground!"
              >
                <div className="font-medium text-foreground">
                  {labelForSegment(s)} — {formatLocalizedNumber(s.credits)}
                </div>
                <div className="text-muted-foreground mt-0.5">{desc}</div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function CreditBalanceChart({
  billing,
  onBuyCredits,
  onComparePlans,
}: {
  billing: BillingStatusResponse;
  onBuyCredits: () => void;
  onComparePlans: () => void;
}) {
  const { t } = useTranslation();
  const segments = billing.creditBreakdown.filter((s) => {
    return s.credits > 0;
  });
  const total = billing.credits;
  const showFreeEmptyPrompt = billing.tier === "limited-free-1" && total <= 0;
  const grants = billing.creditGrants.map((grant: CreditGrant) => {
    return {
      ...grant,
      neverExpires: grant.source === "auto_recharge",
    };
  });
  return (
    <div className="px-5 py-4" data-testid="credit-balance-info">
      <OrgCreditHeader total={total} />

      {showFreeEmptyPrompt ? (
        <div
          className="mt-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-3"
          data-testid="free-empty-credit-prompt"
        >
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.billing.usage.upgradeTitle;
            })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => {
              return $.billing.usage.upgradeDescription;
            })}
          </p>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="mt-3 text-xs"
            onClick={() => {
              onComparePlans();
            }}
          >
            {t(($) => {
              return $.billing.plans.compare;
            })}
          </Button>
        </div>
      ) : null}

      <CreditBreakdownBar
        segments={segments}
        tier={billing.tier}
        total={total}
      />
      <CreditAdditionTable grants={grants} />
      <CreditBalanceActions billing={billing} onBuyCredits={onBuyCredits} />
    </div>
  );
}

/**
 * The single action row of the org credit card: what keeps the balance topped
 * up on the left, what tops it up manually on the right.
 */
function CreditBalanceActions({
  billing,
  onBuyCredits,
}: {
  billing: BillingStatusResponse;
  onBuyCredits: () => void;
}) {
  const { t } = useTranslation();
  const canBuyCredits = orgPlanCapabilitiesFromBilling(billing).canBuyCredits;
  if (!canBuyCredits) {
    return null;
  }
  return (
    <div className="-mx-5 -mb-4 mt-4 flex items-center justify-between gap-3 border-t border-border px-5 py-[18px]">
      <p className="text-[13px] text-muted-foreground">
        {billing.autoRecharge.enabled
          ? t(($) => {
              return $.billing.usage.autoRechargeOn;
            })
          : ""}
      </p>
      <Button
        type="button"
        variant="default"
        size="sm"
        data-testid="credit-balance-buy-credits"
        onClick={() => {
          onBuyCredits();
        }}
      >
        {t(($) => {
          return $.billing.credits.title;
        })}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credit balance card
// ---------------------------------------------------------------------------

/** The org credit wallet, its additions, and the action that tops it up. */
export function CreditBalanceCard({
  onBuyCredits,
  onComparePlans,
}: {
  onBuyCredits: () => void;
  onComparePlans: () => void;
}) {
  const { t } = useTranslation();
  const billingLoadable = useLoadable(billingStatusAsync$);
  const billing =
    billingLoadable.state === "hasData" ? billingLoadable.data : null;
  const billingLoading = billingLoadable.state === "loading";

  return (
    <div className="overflow-hidden rounded-xl bg-card border border-surface-border">
      {billingLoading && !billing ? (
        <div className="px-5 py-4 space-y-2">
          <div className="h-4 w-48 rounded bg-muted/50 animate-pulse" />
          <div className="h-1.5 w-full rounded-full bg-muted/40 animate-pulse" />
        </div>
      ) : billing ? (
        <CreditBalanceChart
          billing={billing}
          onBuyCredits={onBuyCredits}
          onComparePlans={onComparePlans}
        />
      ) : (
        <div className="px-5 py-4">
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.billing.usage.unavailable;
            })}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

export function MemberUsageTable({
  members,
  memberMap,
}: {
  members: MemberUsage[];
  memberMap: Map<string, OrgMember>;
}) {
  const { t } = useTranslation();
  const maxCredits = Math.max(
    1,
    ...members.map((member) => {
      return member.creditsCharged;
    }),
  );

  return (
    <TooltipProvider delay={100}>
      <div className="overflow-hidden rounded-xl bg-card border border-surface-border">
        {/* Header */}
        <div className="grid grid-cols-[1fr_7rem] gap-x-4 items-center px-5 py-2.5 text-[13px] font-medium text-foreground">
          <span>
            {t(($) => {
              return $.billing.usage.member;
            })}
          </span>
          <span className="text-right">
            {t(($) => {
              return $.billing.usage.used;
            })}
          </span>
        </div>
        {members.map((member) => {
          const orgMember = memberMap.get(member.userId);
          const name = orgMember ? displayName(orgMember) : "";
          const label = name || member.email;
          const initial = label.charAt(0).toUpperCase();

          return (
            <div
              key={member.userId}
              data-testid={`member-usage-${member.userId}`}
            >
              <div className="h-0 border-t border-t-gray-400 mx-5" />
              <div className="flex items-center gap-3 px-5 py-3">
                <UserAvatar
                  imageUrl={orgMember?.imageUrl ?? ""}
                  initial={initial}
                  name={label}
                />
                <div className="min-w-0 flex-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-4">
                    <div className="min-w-0">
                      {name ? (
                        <>
                          <p className="truncate text-sm font-medium text-foreground">
                            {name}
                          </p>
                          <p className="truncate text-[13px] text-muted-foreground">
                            {member.email}
                          </p>
                        </>
                      ) : (
                        <p className="truncate text-sm font-medium text-foreground">
                          {member.email}
                        </p>
                      )}
                    </div>
                    <span className="whitespace-nowrap text-right text-[13px] tabular-nums text-foreground">
                      {formatLocalizedNumber(member.creditsCharged)}
                    </span>
                  </div>
                  <UsageBreakdownBar
                    credits={member.creditsCharged}
                    breakdown={member.breakdown}
                    max={maxCredits}
                    testIdPrefix={`member-usage-kind-${member.userId}`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
