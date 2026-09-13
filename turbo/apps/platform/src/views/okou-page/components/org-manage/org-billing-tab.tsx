// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
  type Loadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ExternalLink,
  ArrowLeft,
  ChevronRight,
  Coins,
  Minus,
  Plus,
} from "lucide-react";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX,
  CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN,
  billingStatusAsync$,
  cancelConcurrencySubscription$,
  closeConcurrencyConfirmDialog$,
  closeConcurrencyPurchaseDialog$,
  concurrencyConfirmDialog$,
  concurrencyPurchaseDialogOpen$,
  concurrencySubscriptionQuantity$,
  confirmConcurrencySubscriptionChange$,
  reloadBillingStatus$,
  openConcurrencyConfirmDialog$,
  openConcurrencyPurchaseDialog$,
  openConcurrencyPurchaseReview$,
  previewConcurrencySubscriptionChange$,
  restoreConcurrencySubscription$,
  setConcurrencyChangeMode$,
  setConcurrencyTargetQuantity$,
  startConcurrencyCheckout$,
  openBillingPortal$,
  setConcurrencySubscriptionQuantity$,
  apiTierToBillingTier,
  openDowngradeDialog$,
  closeDowngradeDialog$,
  confirmDowngrade$,
  downgradeDialogOpen$,
  openRestoreDialog$,
  closeRestoreDialog$,
  restoreDialogOpen$,
  restorePlan$,
  usagePackMigrationAsync$,
  type BillingTier,
  type ConcurrencyChangeMode,
  type ConcurrencyConfirmDialogState,
} from "../../../../signals/okou-page/billing.ts";
import { Badge, Button, DialogBody, Input } from "@okouai/ui";
import type {
  BillingStatusResponse,
  ConcurrencySubscriptionChangePreviewResponse,
  UsagePackMigrationStateResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@okouai/ui/components/ui/dialog";
import { detach, Reason } from "../../../../signals/utils.ts";
import { AutoRechargeSection } from "../../billing-dialog.tsx";
import {
  orgPlanCapabilitiesFromBilling,
  type OrgPlanCapabilities,
} from "../../../../signals/okou-page/org-plan-capabilities.ts";
import { BuyCreditsSection } from "./buy-credits-section.tsx";
import {
  billingSubPage$,
  billingMigrationSubPage$,
  billingMigrationTargetTier$,
  buyCreditsScrollRef$,
  openBillingMigrationSubPage$,
  setBillingSubPage$,
  lockedTarget$,
  selectedTarget$,
  setLockedTarget$,
  setSelectedTarget$,
} from "../../../../signals/okou-page/settings/workspace-settings-state.ts";
import { currentLocale, i18n } from "../../../../i18n/index.ts";
import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import {
  dismissBillingPlans$,
  openSettingsUsagePackUpgrade$,
} from "../../../../signals/okou-page/settings/settings-dialog.ts";
import {
  UsagePackMigrationDialogs,
  UsagePackPricingDialogs,
} from "./usage-pack-pricing-page.tsx";

type ScheduledBillingChange = BillingStatusResponse["scheduledChange"];

function planName(tier: BillingTier): string {
  if (tier === "pro") {
    return i18n.t(($) => {
      return $.billing.plans.pro.name;
    });
  }
  if (tier === "team") {
    return i18n.t(($) => {
      return $.billing.plans.team.name;
    });
  }
  if (tier === "custom") {
    return i18n.t(($) => {
      return $.billing.plans.custom.name;
    });
  }
  if (tier === "limited-free-1") {
    return i18n.t(($) => {
      return $.billing.plans.limitedFree.name;
    });
  }
  if (tier === "pro-suspend") {
    return i18n.t(($) => {
      return $.billing.plans.noPlan.name;
    });
  }
  return i18n.t(($) => {
    return $.billing.plans.free.name;
  });
}

function getPlanPrice(tier: "free" | "pro"): string {
  return i18n.t(
    ($) => {
      return $.billing.plans.pricePerMonth;
    },
    { price: formatUsd(tier === "pro" ? 20 : 0, 0) },
  );
}

function isPaidTier(tier: BillingTier): boolean {
  return tier === "pro" || tier === "team" || tier === "custom";
}

function isCustomTier(tier: BillingTier): boolean {
  return tier === "custom";
}

function isNoActivePlanTier(tier: BillingTier): boolean {
  return tier === "limited-free-1" || tier === "pro-suspend";
}

function formatBillingDate(value: string): string {
  return new Date(value).toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function scheduledEffectiveDate(
  scheduledChange: ScheduledBillingChange,
  periodEnd: string | null | undefined,
): string | null {
  return scheduledChange?.effectiveDate ?? periodEnd ?? null;
}

function scheduledTargetLabel(scheduledChange: ScheduledBillingChange): string {
  if (!scheduledChange?.targetTier) {
    return i18n.t(($) => {
      return $.billing.plans.selectedPlan;
    });
  }
  return planName(scheduledChange.targetTier);
}

function scheduledPlanEndsConcurrency(
  scheduledChange: ScheduledBillingChange,
): boolean {
  return (
    scheduledChange?.type === "cancel" ||
    (scheduledChange?.type === "downgrade" &&
      scheduledChange.targetTier === "pro")
  );
}

function billingScheduledChange(
  status: BillingStatusResponse | null,
): ScheduledBillingChange {
  if (!status) {
    return null;
  }
  if (status.scheduledChange) {
    return status.scheduledChange;
  }
  if (status.cancelAtPeriodEnd) {
    return {
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: status.currentPeriodEnd,
    };
  }
  return null;
}

function billingCanRestorePlan(status: BillingStatusResponse | null): boolean {
  return status?.canRestorePlan === true;
}

function billingPaidConcurrency(status: BillingStatusResponse | null): number {
  return (
    status?.concurrencySubscriptions.reduce((total, subscription) => {
      return total + subscription.quantity;
    }, 0) ?? 0
  );
}

type BillingManagementMode = "payment_methods" | null;

function billingManagementMode(
  status: BillingStatusResponse | null,
): BillingManagementMode {
  return status ? "payment_methods" : null;
}

function DowngradeConfirmDialogContent({
  currentTier,
  paidConcurrency,
  periodEnd,
}: {
  currentTier: BillingTier;
  paidConcurrency: number;
  periodEnd: string | null | undefined;
}) {
  const pageSignal = useGet(pageSignal$);
  const [downgradeLoadable, confirm] = useLoadableSet(confirmDowngrade$);
  const loading = downgradeLoadable.state === "loading";
  const error =
    downgradeLoadable.state === "hasError"
      ? String(downgradeLoadable.error)
      : null;
  const close = useSet(closeDowngradeDialog$);
  const selectedTarget = useGet(selectedTarget$);
  const lockedTarget = useGet(lockedTarget$);
  const setSelectedTarget = useSet(setSelectedTarget$);
  const setLockedTarget = useSet(setLockedTarget$);

  const isTeam = currentTier === "team";
  const isLockedTarget = lockedTarget !== null;
  const downgradeTarget = isTeam ? selectedTarget : "limited-free-1";
  const targetLabel = planName(downgradeTarget);
  const proPlanPrice = getPlanPrice("pro");
  const freePlanPrice = getPlanPrice("free");

  const confirmAndResetTarget = async (): Promise<void> => {
    await confirm(downgradeTarget, pageSignal);
    setLockedTarget(null);
  };

  const handleConfirm = () => {
    detach(confirmAndResetTarget(), Reason.DomCallback);
  };

  const handleClose = () => {
    close();
    setLockedTarget(null);
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (v) {
          return;
        }
        handleClose();
      }}
    >
      <DialogContent smMaxWidth={440}>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.billing.downgrade.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {isTeam && isLockedTarget
              ? i18n.t(
                  ($) => {
                    return $.billing.downgrade.confirmTarget;
                  },
                  { plan: targetLabel },
                )
              : isTeam
                ? i18n.t(($) => {
                    return $.billing.downgrade.chooseTarget;
                  })
                : i18n.t(($) => {
                    return $.billing.downgrade.confirmProCancellation;
                  })}
          </DialogDescription>
        </DialogHeader>

        {isTeam && isLockedTarget && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
            {i18n.t(
              ($) => {
                return $.billing.downgrade.teamWarning;
              },
              { plan: targetLabel },
            )}
          </p>
        )}

        {!isTeam && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
            {i18n.t(($) => {
              return $.billing.downgrade.proWarning;
            })}
          </p>
        )}

        {paidConcurrency > 0 && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
            {periodEnd
              ? i18n.t(
                  ($) => {
                    return $.billing.downgrade.concurrencyEndsDate;
                  },
                  {
                    quantity: slotCountLabel(paidConcurrency),
                    date: formatBillingDate(periodEnd),
                  },
                )
              : i18n.t(
                  ($) => {
                    return $.billing.downgrade.concurrencyEndsPeriod;
                  },
                  { quantity: slotCountLabel(paidConcurrency) },
                )}
          </p>
        )}

        {isTeam && !isLockedTarget && (
          <div className="flex flex-col gap-2 mt-2">
            <button
              type="button"
              onClick={() => {
                return setSelectedTarget("pro");
              }}
              className={`flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                selectedTarget === "pro"
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <div>
                <span className="text-sm font-semibold text-foreground">
                  {planName("pro")}
                </span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {proPlanPrice}
                </span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                return setSelectedTarget("limited-free-1");
              }}
              className={`flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                selectedTarget === "limited-free-1" ||
                selectedTarget === "pro-suspend"
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <div>
                <span className="text-sm font-semibold text-foreground">
                  {planName("pro-suspend")}
                </span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {freePlanPrice}
                </span>
              </div>
            </button>
          </div>
        )}

        {error && <p className="text-sm text-destructive mt-2">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading
              ? i18n.t(($) => {
                  return $.billing.downgrade.inProgress;
                })
              : downgradeTarget === "limited-free-1" ||
                  downgradeTarget === "pro-suspend"
                ? i18n.t(($) => {
                    return $.billing.downgrade.cancelSubscription;
                  })
                : i18n.t(
                    ($) => {
                      return $.billing.plans.downgradeTo;
                    },
                    { plan: targetLabel },
                  )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DowngradeConfirmDialog({
  currentTier,
  paidConcurrency,
  periodEnd,
}: {
  currentTier: BillingTier;
  paidConcurrency: number;
  periodEnd: string | null | undefined;
}) {
  const open = useGet(downgradeDialogOpen$);

  if (!open) {
    return null;
  }

  return (
    <DowngradeConfirmDialogContent
      currentTier={currentTier}
      paidConcurrency={paidConcurrency}
      periodEnd={periodEnd}
    />
  );
}

function RestorePlanConfirmDialogContent({
  currentTier,
  paidConcurrency,
  periodEnd,
  scheduledChange,
}: {
  currentTier: BillingTier;
  paidConcurrency: number;
  periodEnd: string | null | undefined;
  scheduledChange: ScheduledBillingChange;
}) {
  const pageSignal = useGet(pageSignal$);
  const close = useSet(closeRestoreDialog$);
  const [restoreLoadable, restore] = useLoadableSet(restorePlan$);
  const loading = restoreLoadable.state === "loading";
  const error =
    restoreLoadable.state === "hasError" ? String(restoreLoadable.error) : null;
  const planLabel = planName(currentTier);
  const changeDate = scheduledEffectiveDate(scheduledChange, periodEnd);
  const description =
    scheduledChange?.type === "downgrade"
      ? i18n.t(
          ($) => {
            return $.billing.restore.downgradeDescription;
          },
          {
            target: scheduledTargetLabel(scheduledChange),
            plan: planLabel,
          },
        )
      : changeDate
        ? i18n.t(
            ($) => {
              return $.billing.restore.cancellationDescriptionDate;
            },
            { plan: planLabel, date: formatBillingDate(changeDate) },
          )
        : i18n.t(
            ($) => {
              return $.billing.restore.cancellationDescription;
            },
            { plan: planLabel },
          );

  const handleConfirm = () => {
    detach(restore(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        return !v && close();
      }}
    >
      <DialogContent smMaxWidth={440}>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(
              ($) => {
                return $.billing.restore.title;
              },
              { plan: planLabel },
            )}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {paidConcurrency > 0 && (
          <p className="text-sm font-semibold text-foreground">
            {i18n.t(
              ($) => {
                return $.billing.restore.concurrencyContinues;
              },
              { quantity: slotCountLabel(paidConcurrency) },
            )}
          </p>
        )}

        {error && <p className="text-sm text-destructive mt-2">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="outline"
            onClick={() => {
              return close();
            }}
            disabled={loading}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button onClick={handleConfirm} disabled={loading}>
            {loading
              ? i18n.t(($) => {
                  return $.billing.restore.inProgress;
                })
              : i18n.t(($) => {
                  return $.billing.plans.restorePlan;
                })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RestorePlanConfirmDialog({
  currentTier,
  paidConcurrency,
  periodEnd,
  scheduledChange,
}: {
  currentTier: BillingTier;
  paidConcurrency: number;
  periodEnd: string | null | undefined;
  scheduledChange: ScheduledBillingChange;
}) {
  const open = useGet(restoreDialogOpen$);

  if (!open) {
    return null;
  }

  return (
    <RestorePlanConfirmDialogContent
      currentTier={currentTier}
      paidConcurrency={paidConcurrency}
      periodEnd={periodEnd}
      scheduledChange={scheduledChange}
    />
  );
}

function PlanActionButtons({
  isPaid,
  hasScheduledChange,
  canRestorePlan,
  currentTier,
  futureTier,
  loading,
  showConvert,
  onConvert,
  onUpgrade,
  onDowngrade,
  onRestore,
}: {
  isPaid: boolean;
  hasScheduledChange: boolean;
  canRestorePlan: boolean;
  currentTier: BillingTier;
  futureTier: "pro" | "team" | null;
  loading: boolean;
  showConvert: boolean;
  onConvert: () => void;
  onUpgrade: () => void;
  onDowngrade: () => void;
  onRestore: () => void;
}) {
  const customLocked = isCustomTier(currentTier);
  const showUpgrade = futureTier
    ? futureTier === "pro"
    : !showConvert &&
      !customLocked &&
      ((isPaid && currentTier !== "team" && !hasScheduledChange) || !isPaid);
  const showDowngrade = futureTier
    ? futureTier === "team"
    : !customLocked && isPaid && !hasScheduledChange;
  const showRestore = !futureTier && !customLocked && isPaid && canRestorePlan;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {showRestore && (
        <Button
          size="sm"
          className="rounded-lg h-8 text-xs"
          disabled={loading}
          onClick={onRestore}
        >
          {i18n.t(($) => {
            return $.billing.plans.restorePlan;
          })}
        </Button>
      )}
      {showUpgrade && (
        <Button
          size="sm"
          className="rounded-lg h-8 text-xs"
          disabled={loading}
          onClick={onUpgrade}
        >
          {i18n.t(($) => {
            return $.billing.plans.upgrade;
          })}
        </Button>
      )}
      {showConvert && (
        <Button
          size="sm"
          className="rounded-lg h-8 text-xs"
          disabled={loading}
          onClick={onConvert}
        >
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.migration.convertPlan;
          })}
        </Button>
      )}
      {showDowngrade && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={loading}
          onClick={onDowngrade}
        >
          {i18n.t(($) => {
            return $.billing.plans.downgrade;
          })}
        </Button>
      )}
    </div>
  );
}

function currentPlanNameLabel(currentTier: BillingTier): string {
  if (isNoActivePlanTier(currentTier)) {
    return i18n.t(($) => {
      return $.billing.plans.noActivePlan;
    });
  }
  return i18n.t(
    ($) => {
      return $.billing.plans.namedPlan;
    },
    { plan: planName(currentTier) },
  );
}

function currentPlanStatusLabel(
  currentTier: BillingTier,
  periodLabel: string | null,
): string {
  if (isCustomTier(currentTier)) {
    return i18n.t(
      ($) => {
        return $.billing.plans.customAccess;
      },
      { value: formatLocalizedNumber(10) },
    );
  }
  return (
    periodLabel ??
    i18n.t(($) => {
      return $.billing.plans.noActiveSubscription;
    })
  );
}

function billingPeriodLabel(args: {
  isPaid: boolean;
  migration: UsagePackMigrationStateResponse | null;
  scheduledChange: ScheduledBillingChange;
  periodEnd: string | null | undefined;
}): string | null {
  const { isPaid, migration, scheduledChange, periodEnd } = args;
  if (!isPaid) {
    return null;
  }

  if (
    migration?.targetTier &&
    migration.effectiveAt &&
    migration.status === "scheduled"
  ) {
    return i18n.t(
      ($) => {
        return $.billing.plans.usagePacks.migration.switchesOn;
      },
      {
        plan: planName(migration.targetTier),
        date: formatBillingDate(migration.effectiveAt),
      },
    );
  }

  const changeDate = scheduledEffectiveDate(scheduledChange, periodEnd);
  if (!changeDate) {
    return null;
  }

  const date = formatBillingDate(changeDate);
  if (scheduledChange?.type === "cancel") {
    return i18n.t(
      ($) => {
        return $.billing.plans.endsOn;
      },
      { date },
    );
  }
  if (scheduledChange?.type === "downgrade") {
    return i18n.t(
      ($) => {
        return $.billing.plans.downgradesOn;
      },
      { plan: scheduledTargetLabel(scheduledChange), date },
    );
  }
  return i18n.t(
    ($) => {
      return $.billing.plans.renews;
    },
    { date },
  );
}

const HIDDEN_BILLING_CONTROLS = Object.freeze({
  canBuyConcurrency: false,
  canBuyCredits: false,
  autoRechargeAllowed: false,
});

function billingControlCapabilities(
  status: BillingStatusResponse | null,
): Pick<
  OrgPlanCapabilities,
  "canBuyConcurrency" | "canBuyCredits" | "autoRechargeAllowed"
> {
  if (!status) {
    return HIDDEN_BILLING_CONTROLS;
  }
  return orgPlanCapabilitiesFromBilling(status);
}

function cancellationNoticeText(tier: BillingTier, changeDate: string): string {
  const formattedDate = formatBillingDate(changeDate);
  if (tier === "custom") {
    return i18n.t(
      ($) => {
        return $.billing.plans.customCancellationNotice;
      },
      { date: formattedDate },
    );
  }
  return i18n.t(
    ($) => {
      return $.billing.plans.cancellationNotice;
    },
    { plan: planName(tier), date: formattedDate },
  );
}

function slotCountLabel(count: number): string {
  return i18n.t(
    ($) => {
      return $.billing.concurrency.slot;
    },
    { count, value: formatLocalizedNumber(count) },
  );
}

function concurrencyMonthlyPrice(
  quantity: number,
  unitAmountCents: number | undefined,
): string | null {
  if (unitAmountCents === undefined) {
    return null;
  }
  const amountCents = quantity * unitAmountCents;
  return i18n.t(
    ($) => {
      return $.billing.plans.pricePerMonth;
    },
    {
      price: formatUsd(amountCents / 100, amountCents % 100 === 0 ? 0 : 2),
    },
  );
}

type ConcurrencySubscription =
  BillingStatusResponse["concurrencySubscriptions"][number];

function concurrencySubscriptionPeriodLabel(
  subscription: ConcurrencySubscription,
  ending: boolean,
  planEndAt: string | null,
): string {
  const endAt = planEndAt ?? subscription.currentPeriodEnd;
  if (!endAt) {
    return ending
      ? i18n.t(($) => {
          return $.billing.concurrency.cancellationScheduled;
        })
      : i18n.t(($) => {
          return $.billing.concurrency.billedMonthly;
        });
  }

  const date = formatBillingDate(endAt);
  return ending
    ? i18n.t(
        ($) => {
          return $.billing.concurrency.activeUntil;
        },
        { date },
      )
    : i18n.t(
        ($) => {
          return $.billing.plans.renews;
        },
        { date },
      );
}

function ConcurrencyQuantityControl({
  autoFocus = false,
  disabled,
  label,
  maximum = CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX,
  minimum = CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN,
  onQuantityChange,
  quantity,
}: {
  autoFocus?: boolean;
  disabled: boolean;
  label: string;
  maximum?: number;
  minimum?: number;
  onQuantityChange: (quantity: number | null) => void;
  quantity: number | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex h-8 items-center rounded-lg border border-border/70 bg-background">
        <Button
          showTooltip
          type="button"
          aria-label={i18n.t(($) => {
            return $.billing.concurrency.decreaseAria;
          })}
          disabled={quantity === null || quantity <= minimum || disabled}
          variant="quiet"
          size="icon-sm"
          className="rounded-l-lg disabled:opacity-40"
          onClick={() => {
            if (quantity !== null) {
              onQuantityChange(quantity - 1);
            }
          }}
        >
          <Minus size={13} />
        </Button>
        <Input
          type="text"
          inputMode="numeric"
          pattern="[1-9][0-9]*"
          value={quantity ?? ""}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-label={label}
          className="h-8 w-11 rounded-none border-y-0 border-x border-border/70 bg-transparent px-1 text-center text-sm font-medium tabular-nums shadow-none focus:border-border focus:ring-0"
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
              nextQuantity >= minimum &&
              nextQuantity <= maximum
            ) {
              onQuantityChange(nextQuantity);
            }
          }}
        />
        <Button
          showTooltip
          type="button"
          aria-label={i18n.t(($) => {
            return $.billing.concurrency.increaseAria;
          })}
          disabled={(quantity !== null && quantity >= maximum) || disabled}
          variant="quiet"
          size="icon-sm"
          className="rounded-r-lg disabled:opacity-40"
          onClick={() => {
            onQuantityChange(quantity === null ? minimum : quantity + 1);
          }}
        >
          <Plus size={13} />
        </Button>
      </div>
    </div>
  );
}

function ConcurrencySubscriptionRow({
  canceled,
  onAction,
  onRestorePlan,
  planEndAt,
  planEnding,
  subscription,
}: {
  canceled: boolean;
  onAction: (args: {
    readonly action: "change" | "restore";
    readonly subscriptionId: string;
    readonly currentQuantity: number;
    readonly canReduce: boolean;
  }) => void;
  onRestorePlan: () => void;
  planEndAt: string | null;
  planEnding: boolean;
  subscription: ConcurrencySubscription;
}) {
  const restoreAvailable =
    canceled ||
    (subscription.scheduledQuantity !== null &&
      subscription.scheduledQuantity !== undefined);
  const action = restoreAvailable ? "restore" : "change";
  const ending = canceled || planEnding;
  const openConcurrencyAction = (
    requestedAction: "change" | "restore",
  ): void => {
    onAction({
      action: requestedAction,
      subscriptionId: subscription.id,
      currentQuantity: subscription.quantity,
      canReduce: subscription.canReduce === true && !planEnding,
    });
  };
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="mb-0.5 text-[12px] font-medium text-muted-foreground first-letter:uppercase">
          {i18n.t(($) => {
            return $.billing.concurrency.paidAddOn;
          })}
        </p>
        <p className="text-sm font-medium text-foreground">
          {slotCountLabel(subscription.quantity)}
        </p>
        <p
          className={`text-[13px] mt-0.5 ${
            ending
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
          }`}
        >
          {concurrencySubscriptionPeriodLabel(subscription, ending, planEndAt)}
        </p>
        {subscription.scheduledQuantity !== null &&
        subscription.scheduledQuantity !== undefined &&
        subscription.scheduledChangeAt ? (
          <p className="mt-0.5 text-[13px] text-amber-600 dark:text-amber-400">
            {i18n.t(
              ($) => {
                return $.billing.concurrency.scheduledChange;
              },
              {
                quantity: slotCountLabel(subscription.scheduledQuantity),
                date: formatBillingDate(subscription.scheduledChangeAt),
              },
            )}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant={restoreAvailable && !planEnding ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => {
            openConcurrencyAction(action);
          }}
        >
          {restoreAvailable
            ? i18n.t(($) => {
                return $.billing.concurrency.restoreConcurrency;
              })
            : i18n.t(($) => {
                return $.billing.concurrency.changeButton;
              })}
        </Button>
        {planEnding && (
          <Button size="sm" className="h-8 text-xs" onClick={onRestorePlan}>
            {i18n.t(($) => {
              return $.billing.concurrency.restoreTeamPlan;
            })}
          </Button>
        )}
      </div>
    </div>
  );
}

interface ConcurrencyConfirmCopy {
  readonly title: string;
  readonly description?: string;
}

function concurrencyConfirmCopy(
  action: "change" | "restore",
  changeMode: ConcurrencyChangeMode,
  reviewing: boolean,
  scheduled: boolean,
  currentQuantity: number,
): ConcurrencyConfirmCopy {
  if (reviewing) {
    return {
      title: i18n.t(($) => {
        return $.billing.concurrency.reviewTitle;
      }),
      ...(scheduled
        ? {
            description: i18n.t(($) => {
              return $.billing.concurrency.scheduledReviewDescription;
            }),
          }
        : {}),
    };
  }
  if (action === "restore") {
    return {
      title: i18n.t(($) => {
        return $.billing.concurrency.restoreTitle;
      }),
      description: i18n.t(
        ($) => {
          return $.billing.concurrency.restoreQuantityDescription;
        },
        { quantity: slotCountLabel(currentQuantity) },
      ),
    };
  }
  if (changeMode === "cancel") {
    return {
      title: i18n.t(($) => {
        return $.billing.concurrency.cancelEntireOption;
      }),
      description: i18n.t(($) => {
        return $.billing.concurrency.cancelDescription;
      }),
    };
  }
  return {
    title: i18n.t(($) => {
      return $.billing.concurrency.changeTitle;
    }),
    description: i18n.t(($) => {
      return $.billing.concurrency.changeQuantityOptionDescription;
    }),
  };
}

function concurrencyMinimumChangeQuantity(
  currentQuantity: number,
  canReduce: boolean,
): number {
  return canReduce
    ? CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN
    : Math.min(CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX, currentQuantity + 1);
}

function concurrencyChangeQuantityAllowed(
  quantity: number | null,
  currentQuantity: number,
  canReduce: boolean,
): boolean {
  return (
    quantity !== null &&
    Number.isInteger(quantity) &&
    quantity >= CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN &&
    quantity <= CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX &&
    (canReduce || quantity >= currentQuantity)
  );
}

function concurrencyChangeQuantityValid(
  quantity: number | null,
  currentQuantity: number,
  canReduce: boolean,
): boolean {
  return (
    concurrencyChangeQuantityAllowed(quantity, currentQuantity, canReduce) &&
    quantity !== currentQuantity
  );
}

function concurrencyConfirmButtonLabel(
  action: "change" | "restore",
  changeMode: ConcurrencyChangeMode,
  preview: ConcurrencySubscriptionChangePreviewResponse | null,
  loading: boolean,
): string {
  if (loading) {
    return i18n.t(($) => {
      return $.billing.common.updating;
    });
  }
  if (action === "restore") {
    return i18n.t(($) => {
      return $.billing.concurrency.restoreConcurrency;
    });
  }
  if (changeMode === "cancel") {
    return i18n.t(($) => {
      return $.billing.downgrade.cancelSubscription;
    });
  }
  if (preview) {
    if (preview.effectiveAt) {
      return i18n.t(($) => {
        return $.billing.concurrency.scheduleChange;
      });
    }
    return preview.immediateAmountCents > 0
      ? i18n.t(($) => {
          return $.billing.concurrency.payAndUpdate;
        })
      : i18n.t(($) => {
          return $.billing.concurrency.updateSlots;
        });
  }
  return i18n.t(($) => {
    return $.billing.concurrency.reviewChange;
  });
}

function concurrencyConfirmDisabled(
  action: "change" | "restore",
  changeMode: ConcurrencyChangeMode,
  loading: boolean,
  changeQuantityValid: boolean,
): boolean {
  return (
    loading ||
    (action === "change" && changeMode === "quantity" && !changeQuantityValid)
  );
}

function ConcurrencyQuantityEditor({
  currentQuantity,
  canReduce,
  targetQuantity,
  loading,
  onQuantityChange,
  unitAmountCents,
}: {
  readonly currentQuantity: number;
  readonly canReduce: boolean;
  readonly targetQuantity: number | null;
  readonly loading: boolean;
  readonly onQuantityChange: (quantity: number | null) => void;
  readonly unitAmountCents: number | undefined;
}) {
  const minimumChangeQuantity = concurrencyMinimumChangeQuantity(
    currentQuantity,
    canReduce,
  );
  const quantityAllowed = concurrencyChangeQuantityAllowed(
    targetQuantity,
    currentQuantity,
    canReduce,
  );

  return (
    <div className="mt-4 divide-y divide-border/70 border-y border-border/70 text-sm">
      <ConcurrencyQuantityControl
        autoFocus
        disabled={loading}
        label={i18n.t(($) => {
          return $.billing.concurrency.slots;
        })}
        minimum={minimumChangeQuantity}
        onQuantityChange={onQuantityChange}
        quantity={targetQuantity}
      />
      <div className="flex items-center justify-between gap-4 py-3">
        <span className="text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.concurrency.monthlyTotal;
          })}
        </span>
        <span className="font-medium tabular-nums text-foreground">
          {quantityAllowed && targetQuantity !== null
            ? (concurrencyMonthlyPrice(targetQuantity, unitAmountCents) ?? "—")
            : "—"}
        </span>
      </div>
    </div>
  );
}

function ConcurrencyChangeReview({
  preview,
}: {
  readonly preview: ConcurrencySubscriptionChangePreviewResponse;
}) {
  return (
    <div className="divide-y divide-border/70 border-y border-border/70 text-sm">
      <div className="flex items-center justify-between gap-4 py-3">
        <span className="text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.concurrency.slots;
          })}
        </span>
        <span className="font-medium tabular-nums text-foreground">
          {formatLocalizedNumber(preview.targetQuantity)}
        </span>
      </div>
      {preview.effectiveAt ? (
        <p className="py-3 text-muted-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.usagePacks.management.scheduledFor;
            },
            { date: formatBillingDate(preview.effectiveAt) },
          )}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-4 py-3">
        <span className="text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.concurrency.monthlyTotal;
          })}
        </span>
        <span className="font-medium tabular-nums text-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.pricePerMonth;
            },
            {
              price: formatUsd(preview.nextRecurringAmountCents / 100),
            },
          )}
        </span>
      </div>
      {preview.immediateAmountCents > 0 && (
        <div className="flex items-center justify-between gap-4 py-3">
          <span className="text-muted-foreground">
            {i18n.t(($) => {
              return $.billing.concurrency.dueToday;
            })}
          </span>
          <span className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
            {formatUsd(preview.immediateAmountCents / 100)}
          </span>
        </div>
      )}
    </div>
  );
}

function ConcurrencyConfirmDialogContent({
  dialog,
  onClose,
}: {
  readonly dialog: Extract<
    ConcurrencyConfirmDialogState,
    { readonly action: "change" | "restore" }
  >;
  readonly onClose: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const status = useLastResolved(billingStatusAsync$);
  const setChangeMode = useSet(setConcurrencyChangeMode$);
  const setTargetQuantity = useSet(setConcurrencyTargetQuantity$);
  const [cancelLoadable, cancelSubscription] = useLoadableSet(
    cancelConcurrencySubscription$,
  );
  const [previewLoadable, previewChange] = useLoadableSet(
    previewConcurrencySubscriptionChange$,
  );
  const [confirmLoadable, confirmChange] = useLoadableSet(
    confirmConcurrencySubscriptionChange$,
  );
  const [restoreLoadable, restoreSubscription] = useLoadableSet(
    restoreConcurrencySubscription$,
  );
  const loading = [
    cancelLoadable.state,
    previewLoadable.state,
    confirmLoadable.state,
    restoreLoadable.state,
  ].includes("loading");
  const action = dialog.action;
  const changeMode = dialog.changeMode;
  const targetQuantity = dialog.targetQuantity;
  const preview = dialog.preview;
  const reviewing = preview !== null;
  const changeQuantityValid = concurrencyChangeQuantityValid(
    targetQuantity,
    dialog.currentQuantity,
    dialog.canReduce,
  );
  const copy = concurrencyConfirmCopy(
    action,
    changeMode,
    reviewing,
    preview?.effectiveAt !== undefined,
    dialog.currentQuantity,
  );

  const handleConfirm = () => {
    if (action === "restore") {
      detach(
        restoreSubscription(dialog.subscriptionId, pageSignal),
        Reason.DomCallback,
      );
      return;
    }
    if (changeMode === "quantity") {
      if (!changeQuantityValid || targetQuantity === null) {
        return;
      }
      if (reviewing) {
        detach(confirmChange(pageSignal), Reason.DomCallback);
        return;
      }
      detach(
        previewChange(
          { subscriptionId: dialog.subscriptionId, quantity: targetQuantity },
          pageSignal,
        ),
        Reason.DomCallback,
      );
      return;
    }
    detach(
      cancelSubscription(dialog.subscriptionId, pageSignal),
      Reason.DomCallback,
    );
  };
  const handleSecondaryAction = () => {
    if (action === "change" && changeMode === "cancel") {
      setChangeMode("quantity");
      return;
    }
    onClose();
  };
  const dialogActions = (
    <>
      <Button
        variant="outline"
        disabled={loading}
        onClick={handleSecondaryAction}
      >
        {i18n.t(($) => {
          return action === "change" && changeMode === "cancel"
            ? $.billing.common.back
            : $.billing.common.cancel;
        })}
      </Button>
      <Button
        variant={
          action === "change" && changeMode === "cancel"
            ? "destructive"
            : "default"
        }
        disabled={concurrencyConfirmDisabled(
          action,
          changeMode,
          loading,
          changeQuantityValid,
        )}
        onClick={handleConfirm}
      >
        {concurrencyConfirmButtonLabel(action, changeMode, preview, loading)}
      </Button>
    </>
  );
  const showCancellationEntry =
    action === "change" &&
    changeMode === "quantity" &&
    !reviewing &&
    dialog.canReduce;

  return (
    <DialogContent smMaxWidth={480}>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        {copy.description ? (
          <DialogDescription>{copy.description}</DialogDescription>
        ) : null}
      </DialogHeader>

      {reviewing && preview ? (
        <ConcurrencyChangeReview preview={preview} />
      ) : action === "change" && changeMode === "quantity" ? (
        <ConcurrencyQuantityEditor
          currentQuantity={dialog.currentQuantity}
          canReduce={dialog.canReduce}
          targetQuantity={targetQuantity}
          loading={loading}
          onQuantityChange={setTargetQuantity}
          unitAmountCents={status?.concurrencyUnitAmountCents}
        />
      ) : null}

      {showCancellationEntry ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="-ml-3 font-normal"
            disabled={loading}
            onClick={() => {
              setChangeMode("cancel");
            }}
          >
            {i18n.t(($) => {
              return $.billing.concurrency.cancelEntireOption;
            })}
          </Button>
          <div className="ml-auto flex justify-end gap-2">{dialogActions}</div>
        </div>
      ) : (
        <DialogFooter>{dialogActions}</DialogFooter>
      )}
    </DialogContent>
  );
}

function ConcurrencyPurchaseReviewDialogContent({
  dialog,
  onClose,
}: {
  readonly dialog: Extract<
    ConcurrencyConfirmDialogState,
    { readonly action: "purchase" }
  >;
  readonly onClose: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(
    startConcurrencyCheckout$,
  );
  const loading = checkoutLoadable.state === "loading";

  return (
    <DialogContent smMaxWidth={420}>
      <DialogHeader>
        <DialogTitle>
          {i18n.t(($) => {
            return $.billing.concurrency.reviewPurchaseTitle;
          })}
        </DialogTitle>
      </DialogHeader>
      <ConcurrencyChangeReview preview={dialog.preview} />
      <DialogFooter>
        <Button variant="outline" disabled={loading} onClick={onClose}>
          {i18n.t(($) => {
            return $.billing.common.cancel;
          })}
        </Button>
        <Button
          disabled={loading}
          onClick={() => {
            detach(
              checkout(dialog.quantity, dialog.newTab, pageSignal),
              Reason.DomCallback,
            );
          }}
        >
          {loading
            ? i18n.t(($) => {
                return $.billing.common.updating;
              })
            : dialog.preview.immediateAmountCents > 0
              ? i18n.t(($) => {
                  return $.billing.concurrency.payAndAddSlots;
                })
              : i18n.t(($) => {
                  return $.billing.concurrency.addSlots;
                })}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function ConcurrencyConfirmDialog() {
  const dialog = useGet(concurrencyConfirmDialog$);
  const close = useSet(closeConcurrencyConfirmDialog$);
  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      {dialog?.action === "purchase" ? (
        <ConcurrencyPurchaseReviewDialogContent
          dialog={dialog}
          onClose={close}
        />
      ) : dialog ? (
        <ConcurrencyConfirmDialogContent dialog={dialog} onClose={close} />
      ) : null}
    </Dialog>
  );
}

function ConcurrencyPurchaseDialog({
  reviewAvailable,
}: {
  readonly reviewAvailable: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const status = useLastResolved(billingStatusAsync$);
  const open = useGet(concurrencyPurchaseDialogOpen$);
  const close = useSet(closeConcurrencyPurchaseDialog$);
  const quantityOverride = useGet(concurrencySubscriptionQuantity$);
  const setQuantity = useSet(setConcurrencySubscriptionQuantity$);
  const [checkoutLoadable, checkout] = useLoadableSet(
    startConcurrencyCheckout$,
  );
  const [reviewLoadable, review] = useLoadableSet(
    openConcurrencyPurchaseReview$,
  );
  const confirmDialog = useGet(concurrencyConfirmDialog$);
  const checkoutLoading =
    checkoutLoadable.state === "loading" ||
    reviewLoadable.state === "loading" ||
    (confirmDialog?.action === "purchase" &&
      confirmDialog.origin === "billing");
  const quantity = quantityOverride;
  const effectiveQuantity = quantity ?? 0;
  const monthlyPrice = concurrencyMonthlyPrice(
    effectiveQuantity,
    status?.concurrencyUnitAmountCents,
  );
  const actionLabel = checkoutLoading
    ? i18n.t(($) => {
        return reviewAvailable
          ? $.billing.common.updating
          : $.billing.common.redirecting;
      })
    : reviewAvailable
      ? i18n.t(($) => {
          return $.billing.concurrency.reviewPurchase;
        })
      : monthlyPrice
        ? i18n.t(
            ($) => {
              return $.billing.concurrency.buyAmount;
            },
            { amount: monthlyPrice },
          )
        : i18n.t(($) => {
            return $.billing.concurrency.buyButton;
          });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        return !v && close();
      }}
    >
      <DialogContent smMaxWidth={420}>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.billing.concurrency.buyTitle;
            })}
          </DialogTitle>
        </DialogHeader>

        <div className="divide-y divide-border/70 border-y border-border/70 text-sm">
          <ConcurrencyQuantityControl
            disabled={checkoutLoading}
            label={i18n.t(($) => {
              return $.billing.concurrency.slots;
            })}
            onQuantityChange={setQuantity}
            quantity={quantity}
          />
          <div className="flex items-center justify-between gap-4 py-3">
            <span className="text-muted-foreground">
              {i18n.t(($) => {
                return $.billing.concurrency.monthlyTotal;
              })}
            </span>
            <span className="font-medium tabular-nums text-foreground">
              {monthlyPrice ?? "—"}
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={checkoutLoading}
            onClick={() => {
              return close();
            }}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button
            disabled={checkoutLoading || quantity === null}
            onClick={(e) => {
              if (quantity === null) {
                return;
              }
              detach(
                reviewAvailable
                  ? review(
                      quantity,
                      e.metaKey || e.ctrlKey,
                      "billing",
                      pageSignal,
                    )
                  : checkout(quantity, e.metaKey || e.ctrlKey, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConcurrencyBillingSection({
  status,
}: {
  status: BillingStatusResponse | null;
}) {
  const openPurchaseDialog = useSet(openConcurrencyPurchaseDialog$);
  const openConfirmDialog = useSet(openConcurrencyConfirmDialog$);
  const openRestorePlan = useSet(openRestoreDialog$);
  const subscriptions = status?.concurrencySubscriptions ?? [];
  const concurrencyLimit = status?.concurrencyLimit ?? 0;
  const paidConcurrency = subscriptions.reduce((total, subscription) => {
    return total + subscription.quantity;
  }, 0);
  const includedConcurrency = concurrencyLimit - paidConcurrency;
  const purchaseReviewAvailable =
    status?.concurrencyPurchaseReviewAvailable === true;
  const scheduledChange = billingScheduledChange(status);
  const planEnding = scheduledPlanEndsConcurrency(scheduledChange);
  const planEndAt = planEnding
    ? scheduledEffectiveDate(scheduledChange, status?.currentPeriodEnd)
    : null;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">
        {i18n.t(($) => {
          return $.billing.concurrency.title;
        })}
      </h3>
      <div className="overflow-hidden rounded-xl bg-card okou-border">
        <div className="px-5 py-4">
          <p className="text-2xl font-medium tracking-tight text-foreground tabular-nums">
            {i18n.t(
              ($) => {
                return $.billing.concurrency.concurrentRun;
              },
              {
                count: concurrencyLimit,
                value: formatLocalizedNumber(concurrencyLimit),
              },
            )}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1 text-[13px] text-muted-foreground">
            <span className="tabular-nums">
              {formatLocalizedNumber(includedConcurrency)}{" "}
              {i18n.t(($) => {
                return $.billing.concurrency.includedWithPlan;
              })}
            </span>
            {paidConcurrency > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {formatLocalizedNumber(paidConcurrency)}{" "}
                  {i18n.t(($) => {
                    return $.billing.concurrency.paidAddOn;
                  })}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="h-0 border-t border-t-gray-400 mx-5" />
        {subscriptions.length === 0 ? (
          <div className="px-5 py-4">
            <p className="text-sm font-medium text-foreground">
              {i18n.t(($) => {
                return $.billing.concurrency.emptyTitle;
              })}
            </p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              {i18n.t(($) => {
                return $.billing.concurrency.emptyDescription;
              })}
            </p>
          </div>
        ) : (
          subscriptions.map((subscription, index) => {
            const canceled = subscription.cancelAtPeriodEnd;
            return (
              <div key={subscription.id}>
                {index > 0 && (
                  <div className="h-0 border-t border-t-gray-400 mx-5" />
                )}
                <ConcurrencySubscriptionRow
                  canceled={canceled}
                  onAction={openConfirmDialog}
                  onRestorePlan={openRestorePlan}
                  planEndAt={planEndAt}
                  planEnding={planEnding}
                  subscription={subscription}
                />
              </div>
            );
          })
        )}
        {subscriptions.length === 0 ? (
          <>
            <div className="h-0 border-t border-t-gray-400 mx-5" />
            <div className="flex justify-end px-5 py-4">
              <Button
                type="button"
                size="sm"
                className="h-9 px-4 text-sm font-medium"
                onClick={openPurchaseDialog}
              >
                {i18n.t(($) => {
                  return $.billing.concurrency.buyButton;
                })}
              </Button>
            </div>
          </>
        ) : null}
      </div>
      <ConcurrencyPurchaseDialog reviewAvailable={purchaseReviewAvailable} />
    </section>
  );
}

function usagePackMigrationStatusLabel(
  migration: UsagePackMigrationStateResponse,
): string {
  if (migration.status === "scheduled" && migration.effectiveAt) {
    return i18n.t(
      ($) => {
        return $.billing.plans.usagePacks.migration.scheduled;
      },
      { date: formatBillingDate(migration.effectiveAt) },
    );
  }
  return i18n.t(($) => {
    return $.billing.plans.usagePacks.migration.processing;
  });
}

function UsagePackMigrationAvailability({
  migration,
  onOpen,
}: {
  readonly migration: UsagePackMigrationStateResponse | null;
  readonly onOpen?: () => void;
}) {
  if (!migration) {
    return null;
  }
  const configurable = usagePackMigrationConfigurable(migration);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.migration.title;
          })}
        </h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.usagePacks.migration.description;
            },
            { plan: planName(migration.tier) },
          )}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-xl bg-card px-5 py-4 okou-border">
        <p className="text-sm text-muted-foreground">
          {configurable
            ? i18n.t(($) => {
                return $.billing.plans.usagePacks.migration.ready;
              })
            : usagePackMigrationStatusLabel(migration)}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {migration.hostedInvoiceUrl && (
            <Button asChild variant="outline" size="sm" className="h-8 text-xs">
              <a
                href={migration.hostedInvoiceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {i18n.t(($) => {
                  return $.billing.plans.usagePacks.migration.invoice;
                })}
                <ExternalLink size={13} strokeWidth={1.5} />
              </a>
            </Button>
          )}
          {configurable && onOpen && (
            <Button size="sm" className="h-8 text-xs" onClick={onOpen}>
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.migration.action;
              })}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function UsagePackMigrationProgressPage({
  migration,
  onBack,
}: {
  readonly migration: UsagePackMigrationStateResponse;
  readonly onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Button
          showTooltip
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onBack}
          aria-label={i18n.t(($) => {
            return $.billing.common.back;
          })}
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
        </Button>
        <h3 className="text-sm font-medium text-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.migration.title;
          })}
        </h3>
      </div>
      <UsagePackMigrationAvailability migration={migration} />
    </div>
  );
}

function StandaloneBillingPricingDialog({
  children,
  open,
  onClose,
  onOpenChangeComplete,
}: {
  readonly children: React.ReactNode;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenChangeComplete?: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <DialogContent
        aria-describedby={undefined}
        maxWidth={860}
        height={688}
        contentClassName="okou-app flex flex-col gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">
          {i18n.t(($) => {
            return $.settings.dialog.sections.billing.title;
          })}
        </DialogTitle>
        <DialogBody className="flex flex-col overflow-y-auto p-5">
          {children}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function billingPricingReplacement({
  onStandaloneClose,
  onStandaloneOpenChangeComplete,
  pricingFlow,
  pricingOpen,
  pricingPage,
  standaloneOpen,
  standalonePlans,
  usagePackPlanDialogs,
}: {
  readonly onStandaloneClose: () => void;
  readonly onStandaloneOpenChangeComplete?: (open: boolean) => void;
  readonly pricingFlow: React.ReactNode;
  readonly pricingOpen: boolean;
  readonly pricingPage: React.ReactNode;
  readonly standaloneOpen: boolean;
  readonly standalonePlans: boolean;
  readonly usagePackPlanDialogs: boolean;
}): React.ReactNode | null {
  if (!pricingOpen) {
    return null;
  }
  if (!usagePackPlanDialogs) {
    return standalonePlans ? (
      <StandaloneBillingPricingDialog
        open={standaloneOpen}
        onClose={onStandaloneClose}
        onOpenChangeComplete={onStandaloneOpenChangeComplete}
      >
        {pricingPage}
      </StandaloneBillingPricingDialog>
    ) : (
      pricingPage
    );
  }
  if (standalonePlans) {
    return pricingFlow;
  }
  return null;
}

function canStartUsagePackCheckout(
  status: BillingStatusResponse | null,
): boolean {
  return status?.hasSubscription === false;
}

function canConfigureGrantedUsagePackPlan(
  status: BillingStatusResponse | null,
): boolean {
  return status?.subscriptionStatus === "atom_grant";
}

function usagePackMigrationInProgress(
  migration: UsagePackMigrationStateResponse | null,
): boolean {
  return migration?.status === "applying";
}

function usagePackMigrationNeedsProgressPage(
  migration: UsagePackMigrationStateResponse | null,
): boolean {
  return (
    usagePackMigrationInProgress(migration) ||
    (migration?.status === "scheduled" && !migration.configuration)
  );
}

/* All actionable usage pack pricing steps live in a dialog over the billing
   tab, including conversion from a legacy plan. Only the loading skeleton and
   a migration that can only report progress still keep the tab sub-page. */
function showsUsagePackPlanDialogs(
  migrationLoading: boolean,
  migration: UsagePackMigrationStateResponse | null,
): boolean {
  return !migrationLoading && !usagePackMigrationNeedsProgressPage(migration);
}

function usagePackMigrationConfigurable(
  migration: UsagePackMigrationStateResponse | null,
): boolean {
  return migration?.status === "eligible" || migration?.status === "previewed";
}

function migrationDowngradeTarget(
  migration: UsagePackMigrationStateResponse | null,
): "pro-suspend" | null {
  return migration ? "pro-suspend" : null;
}

function planActionsLoading(
  portalLoading: boolean,
  migrationInProgress: boolean,
): boolean {
  return portalLoading || migrationInProgress;
}

function loadableDataOrNull<T>(loadable: Loadable<T>): T | null {
  return loadable.state === "hasData" ? loadable.data : null;
}

function scheduledMigrationPlanActions(
  migration: UsagePackMigrationStateResponse | null,
  openPricingPage: () => void,
  handleDowngrade: () => void,
): {
  futureTier: "pro" | "team" | null;
  onDowngrade: () => void;
} {
  if (migration?.status !== "scheduled") {
    return { futureTier: null, onDowngrade: handleDowngrade };
  }
  return {
    futureTier: migration.configuration?.tier ?? null,
    onDowngrade: openPricingPage,
  };
}

function cancellationReplacementAction(
  currentTier: BillingTier,
  scheduledChange: ScheduledBillingChange,
  action: () => void,
): (() => void) | undefined {
  return currentTier === "team" && scheduledChange?.type === "cancel"
    ? action
    : undefined;
}

function CurrentPlanTitle({
  label,
  legacy,
}: {
  readonly label: string;
  readonly legacy: boolean;
}) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
      <span>{label}</span>
      {legacy && (
        <Badge className="text-[10px] font-medium text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.legacy;
          })}
        </Badge>
      )}
    </p>
  );
}

function UsagePackPricingFlowDialogs({
  checkoutAllowed,
  currentTier,
  grantedPlanCheckoutAllowed,
  migration,
  migrationOpen,
  migrationTargetTier,
  onMigrationBack,
  onClose,
  onOpenChangeComplete,
  open,
  onReplaceCancellationWithPro,
  onSelectMigration,
}: {
  readonly checkoutAllowed: boolean;
  readonly currentTier: BillingTier;
  readonly grantedPlanCheckoutAllowed: boolean;
  readonly migration: UsagePackMigrationStateResponse | null;
  readonly migrationOpen: boolean;
  readonly migrationTargetTier: "pro" | "team" | null;
  readonly onMigrationBack: () => void;
  readonly onClose: () => void;
  readonly onOpenChangeComplete?: (open: boolean) => void;
  readonly open: boolean;
  readonly onReplaceCancellationWithPro?: () => void;
  readonly onSelectMigration: (tier: "pro" | "team") => void;
}) {
  if (migration) {
    return (
      <UsagePackMigrationDialogs
        currentTier={currentTier}
        migration={migration}
        migrationOpen={migrationOpen}
        migrationTargetTier={migrationTargetTier}
        onBack={onMigrationBack}
        onClose={onClose}
        onOpenChangeComplete={onOpenChangeComplete}
        open={open}
        onSelect={onSelectMigration}
      />
    );
  }
  return (
    <UsagePackPricingDialogs
      checkoutAllowed={checkoutAllowed}
      currentTier={currentTier}
      grantedPlanCheckoutAllowed={grantedPlanCheckoutAllowed}
      onClose={onClose}
      onOpenChangeComplete={onOpenChangeComplete}
      open={open}
      onReplaceCancellationWithPro={onReplaceCancellationWithPro}
    />
  );
}

/* Only the loading skeleton and the progress page remain on the tab sub-page;
   every actionable pricing step lives in the usage pack dialogs. */
function BillingSubPage({
  migration,
  migrationLoading,
  onBack,
}: {
  readonly migration: UsagePackMigrationStateResponse | null;
  readonly migrationLoading: boolean;
  readonly onBack: () => void;
}) {
  if (migrationLoading) {
    return (
      <div
        role="status"
        className="h-80 animate-pulse rounded-xl bg-muted/40"
      />
    );
  }
  return migration && usagePackMigrationNeedsProgressPage(migration) ? (
    <UsagePackMigrationProgressPage migration={migration} onBack={onBack} />
  ) : null;
}

export function OrgBillingTab({
  standalonePlans = false,
  standaloneOpen,
  onStandaloneOpenChangeComplete,
}: {
  readonly standalonePlans?: boolean;
  readonly standaloneOpen: boolean;
  readonly onStandaloneOpenChangeComplete?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const pricingOpen = useGet(billingSubPage$);
  const migrationOpen = useGet(billingMigrationSubPage$);
  const migrationTargetTier = useGet(billingMigrationTargetTier$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const openMigrationPage = useSet(openBillingMigrationSubPage$);
  const buyCreditsScrollRef = useSet(buyCreditsScrollRef$);
  const dismissPlans = useSet(dismissBillingPlans$);
  const closeBillingSubPage = () => {
    return setBillingSubPage(false);
  };
  const closeMigrationSubPage = () => {
    return setBillingSubPage(true);
  };
  const openPricingPage = () => {
    return setBillingSubPage(true);
  };
  const pageSignal = useGet(pageSignal$);
  const reloadBilling = useSet(reloadBillingStatus$);
  const openDowngrade = useSet(openDowngradeDialog$);
  const setLockedTarget = useSet(setLockedTarget$);
  const openRestore = useSet(openRestoreDialog$);
  const [portalLoadable, portal] = useLoadableSet(openBillingPortal$);
  const [upgradeLoadable, openUsagePackUpgrade] = useLoadableSet(
    openSettingsUsagePackUpgrade$,
  );
  const statusLoadable = useLastLoadable(billingStatusAsync$);
  const migrationLoadable = useLastLoadable(usagePackMigrationAsync$);
  const loading = portalLoadable.state === "loading";
  const upgradeLoading = upgradeLoadable.state === "loading";

  const status = loadableDataOrNull(statusLoadable);
  const migration = loadableDataOrNull(migrationLoadable);
  const migrationLoading = migrationLoadable.state === "loading";
  const migrationInProgress = usagePackMigrationInProgress(migration);
  const canConvertLegacyPlan = usagePackMigrationConfigurable(migration);
  const statusLoading = statusLoadable.state === "loading";
  const statusError = statusLoadable.state === "hasError";
  const capabilities = billingControlCapabilities(status);

  const currentTier = apiTierToBillingTier(status?.tier);
  const isPaid = isPaidTier(currentTier);
  const scheduledChange = billingScheduledChange(status);
  const hasScheduledChange = scheduledChange !== null;
  const canRestorePlan = billingCanRestorePlan(status);
  const isCancelling = scheduledChange?.type === "cancel";
  const isDowngrading = scheduledChange?.type === "downgrade";
  const periodEnd = status?.currentPeriodEnd;
  const paidConcurrency = billingPaidConcurrency(status);
  const periodLabel = billingPeriodLabel({
    isPaid,
    migration,
    scheduledChange,
    periodEnd,
  });
  const changeDate = scheduledEffectiveDate(scheduledChange, periodEnd);

  const handleDowngrade = () => {
    setLockedTarget(migrationDowngradeTarget(migration));
    openDowngrade();
  };
  const handleRestore = () => {
    openRestore();
  };
  const handleReplaceCancellationWithPro = () => {
    closeBillingSubPage();
    setLockedTarget("pro");
    openDowngrade();
  };
  const replaceCancellationWithPro = cancellationReplacementAction(
    currentTier,
    scheduledChange,
    handleReplaceCancellationWithPro,
  );
  const handleUpgrade = () => {
    if (currentTier !== "pro") {
      openPricingPage();
      return;
    }
    detach(openUsagePackUpgrade(pageSignal), Reason.DomCallback);
  };
  const scheduledPlanActions = scheduledMigrationPlanActions(
    migration,
    openPricingPage,
    handleDowngrade,
  );
  const currentPlanLabel = currentPlanNameLabel(currentTier);
  const currentPlanDescription = currentPlanStatusLabel(
    currentTier,
    periodLabel,
  );
  const showBuyCredits = capabilities.canBuyCredits;
  const showConcurrency = capabilities.canBuyConcurrency;
  const managementMode = billingManagementMode(status);
  const canManageBilling = managementMode !== null;
  const openBillingPortal = (event: React.MouseEvent<HTMLButtonElement>) => {
    return detach(
      portal(event.metaKey || event.ctrlKey, pageSignal),
      Reason.DomCallback,
    );
  };

  const usagePackPlanDialogs = showsUsagePackPlanDialogs(
    migrationLoading,
    migration,
  );

  const pricingFlow = (
    <UsagePackPricingFlowDialogs
      checkoutAllowed={canStartUsagePackCheckout(status)}
      currentTier={currentTier}
      grantedPlanCheckoutAllowed={canConfigureGrantedUsagePackPlan(status)}
      migration={migration}
      migrationOpen={migrationOpen}
      migrationTargetTier={migrationTargetTier}
      onMigrationBack={closeMigrationSubPage}
      onClose={dismissPlans}
      onOpenChangeComplete={onStandaloneOpenChangeComplete}
      open={standaloneOpen}
      onReplaceCancellationWithPro={replaceCancellationWithPro}
      onSelectMigration={openMigrationPage}
    />
  );
  const pricingPage = (
    <BillingSubPage
      migration={migration}
      migrationLoading={migrationLoading}
      onBack={dismissPlans}
    />
  );
  const pricingReplacement = billingPricingReplacement({
    onStandaloneClose: dismissPlans,
    onStandaloneOpenChangeComplete,
    pricingFlow,
    pricingOpen,
    pricingPage,
    standaloneOpen,
    standalonePlans,
    usagePackPlanDialogs,
  });

  if (pricingReplacement) {
    return pricingReplacement;
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.plans.sectionTitle;
          })}
        </h3>
        <div className="overflow-hidden rounded-xl bg-card okou-border">
          {statusLoading && !status ? (
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="h-4 w-28 rounded bg-muted/50 animate-pulse" />
                <div className="h-3 w-48 rounded bg-muted/30 animate-pulse mt-1.5" />
              </div>
              <div className="h-8 w-24 shrink-0 rounded-lg bg-muted/30 animate-pulse" />
            </div>
          ) : statusError ? (
            <div className="px-5 py-6 text-center">
              <p className="text-sm text-muted-foreground mb-3">
                {t(($) => {
                  return $.billing.plans.loadError;
                })}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  return reloadBilling();
                }}
              >
                {t(($) => {
                  return $.billing.common.retry;
                })}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <CurrentPlanTitle
                    label={currentPlanLabel}
                    legacy={migration !== null}
                  />
                  <p className="text-[13px] text-muted-foreground mt-0.5">
                    {currentPlanDescription}
                  </p>
                </div>
                <PlanActionButtons
                  isPaid={isPaid}
                  hasScheduledChange={hasScheduledChange}
                  canRestorePlan={canRestorePlan}
                  currentTier={currentTier}
                  futureTier={scheduledPlanActions.futureTier}
                  loading={planActionsLoading(
                    loading || upgradeLoading,
                    migrationInProgress,
                  )}
                  showConvert={canConvertLegacyPlan}
                  onConvert={openPricingPage}
                  onUpgrade={handleUpgrade}
                  onDowngrade={scheduledPlanActions.onDowngrade}
                  onRestore={handleRestore}
                />
              </div>
              {isCancelling && changeDate && (
                <>
                  <div className="h-0 border-t border-t-gray-400 mx-5" />
                  <div className="px-5 py-3">
                    <p className="text-[13px] text-amber-600 dark:text-amber-400">
                      {cancellationNoticeText(currentTier, changeDate)}
                    </p>
                  </div>
                </>
              )}
              {isDowngrading && changeDate && (
                <>
                  <div className="h-0 border-t border-t-gray-400 mx-5" />
                  <div className="px-5 py-3">
                    <p className="text-[13px] text-amber-600 dark:text-amber-400">
                      {t(
                        ($) => {
                          return $.billing.plans.downgradeNotice;
                        },
                        {
                          currentPlan: planName(currentTier),
                          targetPlan: scheduledTargetLabel(scheduledChange),
                          date: formatBillingDate(changeDate),
                        },
                      )}
                    </p>
                  </div>
                </>
              )}
              {canManageBilling && (
                <>
                  <div className="h-0 border-t border-t-gray-400 mx-5" />
                  <div className="flex items-center justify-between gap-4 px-5 py-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {t(($) => {
                          return $.billing.paymentMethods.title;
                        })}
                      </p>
                      <p className="text-[13px] text-muted-foreground mt-0.5">
                        {t(($) => {
                          return $.billing.paymentMethods.description;
                        })}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 h-8 text-xs gap-1.5"
                      disabled={loading}
                      onClick={openBillingPortal}
                    >
                      {t(($) => {
                        return $.billing.common.manage;
                      })}
                      <ExternalLink size={13} />
                    </Button>
                  </div>
                </>
              )}
              <div className="h-0 border-t border-t-gray-400" />
              <button
                type="button"
                className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left transition-colors bg-muted/20 hover:bg-state-hover"
                onClick={openPricingPage}
              >
                <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                  {t(($) => {
                    return $.billing.plans.compareAll;
                  })}
                  <Coins size={14} className="text-foreground/40" />
                </span>
                <ChevronRight size={14} className="shrink-0" />
              </button>
            </>
          )}
        </div>
      </section>

      {showBuyCredits && (
        <div ref={buyCreditsScrollRef}>
          <BuyCreditsSection />
        </div>
      )}

      {status && (
        <AutoRechargeSection
          allowed={capabilities.autoRechargeAllowed}
          loading={loading}
        />
      )}

      {showConcurrency && <ConcurrencyBillingSection status={status} />}

      {pricingOpen && pricingFlow}

      <DowngradeConfirmDialog
        currentTier={currentTier}
        paidConcurrency={paidConcurrency}
        periodEnd={periodEnd}
      />
      <RestorePlanConfirmDialog
        currentTier={currentTier}
        paidConcurrency={paidConcurrency}
        periodEnd={periodEnd}
        scheduledChange={scheduledChange}
      />
    </div>
  );
}
