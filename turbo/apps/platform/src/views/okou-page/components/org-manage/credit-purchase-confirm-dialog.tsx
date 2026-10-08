import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { CreditPurchasePreviewResponse } from "@okouai/api-contracts/contracts/billing";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import {
  closeCreditPurchasePreview$,
  confirmCreditPurchase$,
  creditPurchasePreview$,
} from "../../../../signals/okou-page/billing.ts";
import {
  formatPurchaseAmount,
  PurchaseConfirmDialogShell,
} from "./purchase-confirm-dialog-shell.tsx";

function CreditPurchaseConfirmDialogContent({
  preview,
}: {
  readonly preview: CreditPurchasePreviewResponse;
}) {
  const { t } = useTranslation();

  return (
    <PurchaseConfirmDialogShell
      close$={closeCreditPurchasePreview$}
      confirm$={confirmCreditPurchase$}
      title={t(($) => {
        return $.billing.credits.reviewTitle;
      })}
      description={t(($) => {
        return $.billing.credits.reviewDescription;
      })}
      errorMessage={t(($) => {
        return $.billing.credits.reviewError;
      })}
      confirmLabel={t(($) => {
        return $.billing.credits.payAndAddCredits;
      })}
    >
      <div className="mt-1 min-w-0">
        <p className="pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
          {t(($) => {
            return $.billing.credits.today;
          })}
        </p>
        <div className="grid min-w-0 grid-cols-1 gap-1 border-t border-border py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3">
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.billing.credits.dueNow;
            })}
          </p>
          <p className="min-w-0 break-words text-left text-2xl font-light tracking-tight tabular-nums text-foreground sm:text-right sm:text-3xl">
            {formatPurchaseAmount(preview.amountCents, preview.currency)}
          </p>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-1 border-t border-[hsl(var(--gray-100))] py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3">
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.billing.credits.creditsAdded;
            })}
          </p>
          <p className="min-w-0 break-words text-left text-sm font-medium tabular-nums text-foreground sm:text-right">
            +{formatLocalizedNumber(preview.credits)}
          </p>
        </div>
      </div>
    </PurchaseConfirmDialogShell>
  );
}

export function CreditPurchaseConfirmDialog() {
  const preview = useGet(creditPurchasePreview$);

  if (!preview) {
    return null;
  }

  return (
    <CreditPurchaseConfirmDialogContent
      key={preview.previewToken}
      preview={preview}
    />
  );
}
