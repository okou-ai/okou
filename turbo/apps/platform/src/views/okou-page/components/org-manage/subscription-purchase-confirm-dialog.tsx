import type {
  PlanPurchasePreviewResponse,
  UsagePackPurchasePreviewResponse,
} from "@okouai/api-contracts/contracts/billing";
import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  closeSubscriptionPurchasePreview$,
  confirmSubscriptionPurchase$,
  subscriptionPurchasePreview$,
} from "../../../../signals/okou-page/billing.ts";
import {
  formatPurchaseAmount,
  PurchaseConfirmDialogShell,
} from "./purchase-confirm-dialog-shell.tsx";

type SubscriptionPurchasePreview =
  PlanPurchasePreviewResponse | UsagePackPurchasePreviewResponse;

function SubscriptionPurchaseSummary({
  preview,
  planName,
}: {
  readonly preview: SubscriptionPurchasePreview;
  readonly planName: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-1">
      <p className="pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.billing.credits.today;
        })}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-3.5">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.concurrency.dueNow;
          })}
        </p>
        <p className="text-right text-3xl font-light tracking-tight tabular-nums text-foreground">
          {formatPurchaseAmount(preview.immediateAmountCents, preview.currency)}
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-[hsl(var(--gray-100))] py-2.5">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.plans.usagePacks.planStep;
          })}
        </p>
        <p className="text-right text-sm font-medium text-foreground">
          {planName}
        </p>
      </div>
      <p className="pb-0.5 pt-4 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.billing.plans.usagePacks.management.everyMonth;
        })}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-3.5">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.concurrency.monthlyTotal;
          })}
        </p>
        <p className="text-right text-3xl font-light tracking-tight tabular-nums text-foreground">
          {formatPurchaseAmount(
            preview.nextRecurringAmountCents,
            preview.currency,
          )}
        </p>
      </div>
    </div>
  );
}

function SubscriptionPurchaseConfirmDialogContent({
  preview,
}: {
  readonly preview: SubscriptionPurchasePreview;
}) {
  const { t } = useTranslation();
  const planName =
    preview.tier === "pro"
      ? t(($) => {
          return $.billing.plans.pro.name;
        })
      : t(($) => {
          return $.billing.plans.team.name;
        });
  const upgradeLabel = t(
    ($) => {
      return $.billing.plans.upgradeTo;
    },
    { plan: planName },
  );
  const confirmLabel =
    preview.purchaseType === "plan"
      ? upgradeLabel
      : t(($) => {
          return $.billing.common.confirm;
        });
  return (
    <PurchaseConfirmDialogShell
      close$={closeSubscriptionPurchasePreview$}
      confirm$={confirmSubscriptionPurchase$}
      title={
        preview.purchaseType === "plan"
          ? upgradeLabel
          : t(($) => {
              return $.billing.plans.usagePacks.orderSummary;
            })
      }
      description={t(($) => {
        return $.billing.concurrency.reviewDescription;
      })}
      errorMessage={t(($) => {
        return $.billing.plans.usagePacks.planChangeError;
      })}
      confirmLabel={confirmLabel}
    >
      <SubscriptionPurchaseSummary preview={preview} planName={planName} />
    </PurchaseConfirmDialogShell>
  );
}

export function SubscriptionPurchaseConfirmDialog() {
  const state = useGet(subscriptionPurchasePreview$);

  if (!state) {
    return null;
  }

  return (
    <SubscriptionPurchaseConfirmDialogContent
      key={state.preview.previewToken}
      preview={state.preview}
    />
  );
}
