import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import type { ConcurrencyInfo } from "@okouai/api-contracts/contracts/runs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Button,
  Input,
  Badge,
} from "@okouai/ui";
import { Crown, Minus, Plus } from "lucide-react";
import {
  CONCURRENCY_QUANTITY_MAX,
  CONCURRENCY_QUANTITY_MIN,
  concurrencyQuantity$,
  queueDrawerOpen$,
  setConcurrencyQuantity$,
  setQueueDrawerOpen$,
} from "../../signals/queue-page/queue-drawer-state.ts";
import { queueDataFromWorker$ } from "../../signals/shared-database.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  billingStatusAsync$,
  concurrencyConfirmDialog$,
  type ConcurrencyConfirmDialogState,
  openConcurrencyChangeReview$,
  openConcurrencyPurchaseReview$,
  startCheckout$,
  startConcurrencyCheckout$,
} from "../../signals/okou-page/billing.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { orgPlanCapabilitiesFromBilling } from "../../signals/okou-page/org-plan-capabilities.ts";

// ---------------------------------------------------------------------------
// Upgrade path config: free → pro, pro → team
// ---------------------------------------------------------------------------

interface UpgradePath {
  targetTier: "pro" | "team";
  targetLabel: string;
  concurrentRuns: number;
  monthlyPriceUsd: number;
  description: string;
  features: readonly string[];
}

const UPGRADE_PATHS = {
  free: {
    targetTier: "pro",
    targetLabel: "Pro",
    concurrentRuns: 2,
    monthlyPriceUsd: 20,
  },
  pro: {
    targetTier: "team",
    targetLabel: "Team",
    concurrentRuns: 10,
    monthlyPriceUsd: 200,
  },
} as const;

function concurrencyMonthlyTotalCents(
  quantity: number,
  unitAmountCents: number | undefined,
): number | null {
  return unitAmountCents === undefined ? null : quantity * unitAmountCents;
}

function formatConcurrencyMonthlyTotal(
  language: string | undefined,
  quantity: number,
  unitAmountCents: number | undefined,
): string | null {
  const monthlyTotalCents = concurrencyMonthlyTotalCents(
    quantity,
    unitAmountCents,
  );
  if (monthlyTotalCents === null) {
    return null;
  }
  const fractionDigits = monthlyTotalCents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(monthlyTotalCents / 100);
}

function useUpgradePath(tier: string): UpgradePath | undefined {
  const { i18n, t } = useTranslation();
  const numberFormat = new Intl.NumberFormat(i18n.resolvedLanguage);
  const base =
    tier in UPGRADE_PATHS
      ? UPGRADE_PATHS[tier as keyof typeof UPGRADE_PATHS]
      : undefined;
  if (!base) {
    return undefined;
  }
  const credits = base.targetTier === "pro" ? 20_000 : 120_000;
  const support =
    base.targetTier === "pro"
      ? t(($) => {
          return $.queue.upgrade.features.emailSupport;
        })
      : t(($) => {
          return $.queue.upgrade.features.prioritySupport;
        });
  return {
    ...base,
    description:
      base.targetTier === "pro"
        ? t(($) => {
            return $.queue.upgrade.proDescription;
          })
        : t(($) => {
            return $.queue.upgrade.teamDescription;
          }),
    features: [
      t(
        ($) => {
          return $.queue.upgrade.features.creditsPerMonth;
        },
        { credits: numberFormat.format(credits) },
      ),
      t(($) => {
        return $.queue.upgrade.features.payAsYouGo;
      }),
      t(
        ($) => {
          return $.queue.concurrentRuns;
        },
        { count: base.concurrentRuns },
      ),
      t(($) => {
        return $.queue.upgrade.features.unlimitedAgents;
      }),
      t(($) => {
        return $.queue.upgrade.features.ownKeys;
      }),
      support,
    ],
  };
}

// ---------------------------------------------------------------------------
// Check icon matching plan comparison page
// ---------------------------------------------------------------------------

function CheckCircleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="stroke-icon shrink-0 text-muted-foreground/40"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="16 9 10.5 15 8 12.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Drawer content
// ---------------------------------------------------------------------------

function CurrentPlanStatus({
  concurrency,
  tierColor,
  tierLabel,
}: {
  readonly concurrency: ConcurrencyInfo;
  readonly tierColor: string;
  readonly tierLabel: string;
}) {
  const { i18n, t } = useTranslation();
  const { memberUsage } = concurrency;
  const numberFormat = new Intl.NumberFormat(i18n.resolvedLanguage);
  const slotCountLabel = (count: number): string => {
    return t(
      ($) => {
        return $.billing.concurrency.slot;
      },
      { count, value: numberFormat.format(count) },
    );
  };

  return (
    <div className="shrink-0 rounded-[var(--okou-card-radius)] okou-border p-5">
      <p className={`mb-3 text-sm font-mono font-semibold ${tierColor}`}>
        {tierLabel}
      </p>
      <div className="flex items-center gap-2 mb-2">
        {Array.from({ length: concurrency.limit }, (_, i) => {
          const filled = i < concurrency.active;
          return (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full ${filled ? "bg-destructive" : "bg-muted"}`}
            />
          );
        })}
      </div>
      <p className="text-lg font-medium text-foreground">
        {t(
          ($) => {
            return $.queue.status.inUse;
          },
          {
            active: concurrency.active,
            count: concurrency.limit,
            limit: concurrency.limit,
          },
        )}
      </p>
      <div className="mt-3">
        {memberUsage.length > 0 && (
          <ul className="flex flex-col gap-2.5">
            {memberUsage.map((member) => {
              return (
                <li
                  key={member.userId}
                  className="flex min-w-0 items-center justify-between gap-4 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-3 text-foreground">
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-muted-foreground/65"
                    />
                    <span className="truncate font-light">
                      {member.displayName}
                    </span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-foreground">
                    {slotCountLabel(member.active)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div
          className={`flex items-center justify-between gap-4 text-sm ${
            memberUsage.length > 0
              ? "mt-4 border-t border-border/60 pt-3"
              : "mt-3"
          }`}
        >
          <span className="font-light text-muted-foreground">
            {t(($) => {
              return $.queue.status.availableNow;
            })}
          </span>
          <span className="shrink-0 font-medium tabular-nums text-foreground">
            {slotCountLabel(Math.max(0, concurrency.available))}
          </span>
        </div>
      </div>
    </div>
  );
}

function UpgradeCard({
  loading,
  onCheckout,
  tierColor,
  upgrade,
}: {
  readonly loading: boolean;
  readonly onCheckout: (newTab: boolean) => void;
  readonly tierColor: string;
  readonly upgrade: UpgradePath;
}) {
  const { i18n, t } = useTranslation();
  const currencyFormat = new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return (
    <div className="flex-1 flex flex-col rounded-[var(--okou-card-radius)] okou-border p-5">
      <div className="flex items-start justify-between mb-2">
        <h3 className={`text-sm font-mono font-semibold ${tierColor}`}>
          {upgrade.targetLabel}
        </h3>
        <Badge className="text-xs font-medium text-muted-foreground">
          <Crown className="text-amber-500" />
          {t(($) => {
            return $.queue.upgrade.recommended;
          })}
        </Badge>
      </div>

      <p className="text-lg font-medium text-foreground mb-1">
        {t(
          ($) => {
            return $.queue.concurrentRuns;
          },
          { count: upgrade.concurrentRuns },
        )}
      </p>
      <p className="text-[13px] font-light text-muted-foreground leading-relaxed mb-4">
        {upgrade.description}
      </p>

      <div className="flex items-baseline gap-1.5 mb-4">
        <span className="text-2xl font-light tracking-tight text-foreground">
          {currencyFormat.format(upgrade.monthlyPriceUsd)}
        </span>
        <span className="text-sm font-light text-muted-foreground">
          {t(($) => {
            return $.queue.perMonth;
          })}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {upgrade.features.map((feature: string) => {
          return (
            <li key={feature} className="flex items-center gap-2">
              <CheckCircleIcon />
              <span className="text-[13px] font-light text-muted-foreground">
                {feature}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto pt-5">
        <Button
          className="w-full h-11 text-sm font-medium"
          disabled={loading}
          onClick={(e) => {
            onCheckout(e.metaKey || e.ctrlKey);
          }}
        >
          {loading
            ? t(($) => {
                return $.queue.redirecting;
              })
            : t(
                ($) => {
                  return $.queue.upgrade.action;
                },
                { plan: upgrade.targetLabel },
              )}
        </Button>
      </div>
    </div>
  );
}

function ConcurrencyQuantityControl({
  loading,
  onQuantityChange,
  quantity,
}: {
  readonly loading: boolean;
  readonly onQuantityChange: (quantity: number | null) => void;
  readonly quantity: number | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.queue.purchase.quantity;
          })}
        </span>
        <div className="flex h-9 items-center rounded-lg border border-border/70 bg-background">
          <Button
            showTooltip
            type="button"
            aria-label={t(($) => {
              return $.queue.purchase.decreaseQuantity;
            })}
            disabled={
              quantity === null ||
              quantity <= CONCURRENCY_QUANTITY_MIN ||
              loading
            }
            variant="quiet"
            size="icon"
            className="rounded-l-lg disabled:opacity-40"
            onClick={() => {
              if (quantity !== null) {
                onQuantityChange(quantity - 1);
              }
            }}
          >
            <Minus size={14} />
          </Button>
          <Input
            type="text"
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            value={quantity ?? ""}
            disabled={loading}
            aria-label={t(($) => {
              return $.queue.purchase.quantity;
            })}
            className="h-9 w-14 rounded-none border-y-0 border-x border-border/70 bg-transparent px-1 text-center text-sm font-medium tabular-nums shadow-none focus:border-border focus:ring-0"
            onChange={(event) => {
              const nextValue = event.currentTarget.value;
              if (nextValue === "") {
                onQuantityChange(null);
                return;
              }
              if (!/^[1-9]\d*$/.test(nextValue)) {
                return;
              }
              const nextQuantity = Number(nextValue);
              if (
                Number.isInteger(nextQuantity) &&
                nextQuantity >= CONCURRENCY_QUANTITY_MIN &&
                nextQuantity <= CONCURRENCY_QUANTITY_MAX
              ) {
                onQuantityChange(nextQuantity);
              }
            }}
          />
          <Button
            showTooltip
            type="button"
            aria-label={t(($) => {
              return $.queue.purchase.increaseQuantity;
            })}
            disabled={
              (quantity !== null && quantity >= CONCURRENCY_QUANTITY_MAX) ||
              loading
            }
            variant="quiet"
            size="icon"
            className="rounded-r-lg disabled:opacity-40"
            onClick={() => {
              onQuantityChange(
                quantity === null ? CONCURRENCY_QUANTITY_MIN : quantity + 1,
              );
            }}
          >
            <Plus size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConcurrencyPurchaseCard({
  loading,
  onCheckout,
  onQuantityChange,
  quantity,
  reviewingInApp,
  tierColor,
  unitAmountCents,
}: {
  readonly loading: boolean;
  readonly onCheckout: (newTab: boolean) => void;
  readonly onQuantityChange: (quantity: number | null) => void;
  readonly quantity: number | null;
  readonly reviewingInApp: boolean;
  readonly tierColor: string;
  readonly unitAmountCents: number | undefined;
}) {
  const { i18n, t } = useTranslation();
  const effectiveQuantity = quantity ?? 0;
  const monthlyTotal = formatConcurrencyMonthlyTotal(
    i18n.resolvedLanguage,
    effectiveQuantity,
    unitAmountCents,
  );
  return (
    <div className="flex-1 flex flex-col rounded-[var(--okou-card-radius)] okou-border p-5">
      <div className="flex items-start justify-between mb-2">
        <h3 className={`text-sm font-mono font-semibold ${tierColor}`}>
          {t(($) => {
            return $.queue.purchase.title;
          })}
        </h3>
        <Badge className="text-xs font-medium text-muted-foreground">
          <Crown className="text-amber-500" />
          {t(($) => {
            return $.queue.purchase.addOn;
          })}
        </Badge>
      </div>

      <p className="text-lg font-medium text-foreground mb-1">
        {t(
          ($) => {
            return $.queue.purchase.subscription;
          },
          { count: effectiveQuantity },
        )}
      </p>
      <p className="text-[13px] font-light text-muted-foreground leading-relaxed mb-4">
        {t(($) => {
          return $.queue.purchase.description;
        })}
      </p>

      <ConcurrencyQuantityControl
        loading={loading}
        onQuantityChange={onQuantityChange}
        quantity={quantity}
      />

      <p className="mt-4 text-sm font-medium text-foreground">
        {monthlyTotal
          ? t(
              ($) => {
                return $.queue.pricePerMonth;
              },
              { price: monthlyTotal },
            )
          : "—"}
      </p>

      <ul className="flex flex-col gap-2 mt-4">
        <li className="flex items-center gap-2">
          <CheckCircleIcon />
          <span className="text-[13px] font-light text-muted-foreground">
            {t(($) => {
              return $.queue.purchase.addsToLimit;
            })}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <CheckCircleIcon />
          <span className="text-[13px] font-light text-muted-foreground">
            {reviewingInApp
              ? t(($) => {
                  return $.billing.concurrency.reviewDescription;
                })
              : t(($) => {
                  return $.queue.purchase.appliedAfterCheckout;
                })}
          </span>
        </li>
      </ul>

      <div className="mt-auto pt-5">
        <Button
          className="w-full h-11 text-sm font-medium"
          disabled={loading || quantity === null}
          onClick={(e) => {
            onCheckout(e.metaKey || e.ctrlKey);
          }}
        >
          {loading
            ? reviewingInApp
              ? t(($) => {
                  return $.billing.common.updating;
                })
              : t(($) => {
                  return $.queue.redirecting;
                })
            : monthlyTotal
              ? t(
                  ($) => {
                    return $.queue.purchase.buy;
                  },
                  { price: monthlyTotal },
                )
              : t(($) => {
                  return $.billing.concurrency.buyButton;
                })}
        </Button>
      </div>
    </div>
  );
}

function isQueueConcurrencyReviewOpen({
  activeChangeReviewAvailable,
  activeSubscriptionId,
  confirmDialog,
  purchaseReviewAvailable,
}: {
  readonly activeChangeReviewAvailable: boolean;
  readonly activeSubscriptionId: string | undefined;
  readonly confirmDialog: ConcurrencyConfirmDialogState | null;
  readonly purchaseReviewAvailable: boolean;
}): boolean {
  if (confirmDialog?.action === "purchase") {
    return purchaseReviewAvailable && confirmDialog.origin === "queue";
  }
  return (
    activeChangeReviewAvailable &&
    confirmDialog?.action === "change" &&
    confirmDialog.subscriptionId === activeSubscriptionId
  );
}

function ConcurrencyPurchaseCardMount({
  canManageBilling,
  tierColor,
}: {
  readonly canManageBilling: boolean;
  readonly tierColor: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(
    startConcurrencyCheckout$,
  );
  const [reviewLoadable, openReview] = useLoadableSet(
    openConcurrencyChangeReview$,
  );
  const [purchaseReviewLoadable, openPurchaseReview] = useLoadableSet(
    openConcurrencyPurchaseReview$,
  );
  const quantity = useGet(concurrencyQuantity$);
  const confirmDialog = useGet(concurrencyConfirmDialog$);
  const setQuantity = useSet(setConcurrencyQuantity$);
  const billingStatus = useLastResolved(billingStatusAsync$);
  const capabilities = billingStatus
    ? orgPlanCapabilitiesFromBilling(billingStatus)
    : undefined;
  const activeSubscription = billingStatus?.concurrencySubscriptions.find(
    (subscription) => {
      return !subscription.cancelAtPeriodEnd;
    },
  );
  const activeChangeReviewAvailable = activeSubscription !== undefined;
  const purchaseReviewAvailable =
    !activeSubscription &&
    billingStatus?.concurrencyPurchaseReviewAvailable === true;
  const reviewingInApp = activeChangeReviewAvailable || purchaseReviewAvailable;
  const reviewDialogOpen = isQueueConcurrencyReviewOpen({
    activeChangeReviewAvailable,
    activeSubscriptionId: activeSubscription?.id,
    confirmDialog,
    purchaseReviewAvailable,
  });
  const loading =
    checkoutLoadable.state === "loading" ||
    reviewLoadable.state === "loading" ||
    purchaseReviewLoadable.state === "loading" ||
    reviewDialogOpen;

  if (!canManageBilling || capabilities?.canBuyConcurrency !== true) {
    return null;
  }

  return (
    <ConcurrencyPurchaseCard
      loading={loading}
      onCheckout={(newTab) => {
        if (quantity === null) {
          return;
        }
        if (activeChangeReviewAvailable && activeSubscription) {
          detach(
            openReview(
              {
                subscriptionId: activeSubscription.id,
                currentQuantity: activeSubscription.quantity,
                targetQuantity: activeSubscription.quantity + quantity,
                canReduce: activeSubscription.canReduce === true,
              },
              pageSignal,
            ),
            Reason.DomCallback,
          );
          return;
        }
        if (purchaseReviewAvailable) {
          detach(
            openPurchaseReview(quantity, newTab, "queue", pageSignal),
            Reason.DomCallback,
          );
          return;
        }
        detach(checkout(quantity, newTab, pageSignal), Reason.DomCallback);
      }}
      onQuantityChange={setQuantity}
      quantity={quantity}
      reviewingInApp={reviewingInApp}
      tierColor={tierColor}
      unitAmountCents={billingStatus?.concurrencyUnitAmountCents}
    />
  );
}

function QueueDrawerContent() {
  const { t } = useTranslation();
  const dataLoadable = useLastLoadable(queueDataFromWorker$);
  const data = dataLoadable.state === "hasData" ? dataLoadable.data : null;
  const pageSignal = useGet(pageSignal$);
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const [planCheckoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const planCheckoutLoading = planCheckoutLoadable.state === "loading";
  const upgrade = useUpgradePath(data?.concurrency.tier ?? "");

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-24 animate-pulse rounded-[var(--okou-card-radius)] bg-muted/20" />
        <div className="h-48 animate-pulse rounded-[var(--okou-card-radius)] bg-muted/20" />
      </div>
    );
  }

  const { concurrency } = data;
  const tierLabel =
    concurrency.tier === "limited-free-1"
      ? t(($) => {
          return $.queue.tiers.limitedFree;
        })
      : concurrency.tier === "pro-suspend"
        ? t(($) => {
            return $.queue.tiers.noPlan;
          })
        : concurrency.tier === "free"
          ? t(($) => {
              return $.queue.tiers.free;
            })
          : concurrency.tier === "pro"
            ? t(($) => {
                return $.queue.tiers.pro;
              })
            : concurrency.tier === "team"
              ? t(($) => {
                  return $.queue.tiers.team;
                })
              : t(($) => {
                  return $.queue.tiers.custom;
                });
  const canManageBilling =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const visibleUpgrade = canManageBilling ? upgrade : undefined;

  const tierColor = "text-[#D27939]";

  return (
    <div className="flex flex-col gap-4 h-full">
      <CurrentPlanStatus
        concurrency={concurrency}
        tierColor={tierColor}
        tierLabel={tierLabel}
      />

      {visibleUpgrade && (
        <UpgradeCard
          loading={planCheckoutLoading}
          onCheckout={(newTab) => {
            detach(
              checkout(
                visibleUpgrade.targetTier,
                newTab,
                undefined,
                pageSignal,
              ),
              Reason.DomCallback,
            );
          }}
          tierColor={tierColor}
          upgrade={visibleUpgrade}
        />
      )}

      <ConcurrencyPurchaseCardMount
        canManageBilling={canManageBilling}
        tierColor={tierColor}
      />
    </div>
  );
}

export function QueueDrawer() {
  const { t } = useTranslation();
  const open = useGet(queueDrawerOpen$);
  const setOpen = useSet(setQueueDrawerOpen$);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setOpen(false);
        }
      }}
    >
      <SheetContent
        side="right"
        className="w-[400px] sm:max-w-[400px] flex flex-col"
        initialFocus={false}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>
            {t(($) => {
              return $.queue.title;
            })}
          </SheetTitle>
          <SheetDescription>
            {t(($) => {
              return $.queue.description;
            })}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 -mb-6 pb-6">
          <QueueDrawerContent />
        </div>
      </SheetContent>
    </Sheet>
  );
}
