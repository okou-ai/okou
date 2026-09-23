import type { ReactNode } from "react";
import type { Command } from "ccstate";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export function formatPurchaseAmount(
  amountCents: number,
  currency: string,
): string {
  return formatLocalizedNumber(amountCents / 100, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function PurchaseConfirmDialogShell({
  close$,
  confirm$,
  title,
  description,
  errorMessage,
  confirmLabel,
  children,
}: {
  readonly close$: Command<void, []>;
  readonly confirm$: Command<Promise<unknown>, [AbortSignal]>;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly errorMessage: ReactNode;
  readonly confirmLabel: ReactNode;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const close = useSet(close$);
  const pageSignal = useGet(pageSignal$);
  const [confirmLoadable, confirm] = useLoadableSet(confirm$);
  const confirming = confirmLoadable.state === "loading";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !confirming) {
          close();
        }
      }}
    >
      <DialogContent smMaxWidth={420}>
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="break-words leading-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="break-words">
            {description}
          </DialogDescription>
        </DialogHeader>

        {children}

        {confirmLoadable.state === "hasError" && (
          <p className="text-sm text-destructive">{errorMessage}</p>
        )}

        <DialogFooter className="min-w-0">
          <Button
            variant="outline"
            disabled={confirming}
            onClick={close}
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal break-words py-2 text-center sm:w-auto"
          >
            {t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button
            disabled={confirming}
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal break-words py-2 text-center sm:w-auto"
            onClick={() => {
              detach(confirm(pageSignal), Reason.DomCallback);
            }}
          >
            {confirming
              ? t(($) => {
                  return $.billing.common.updating;
                })
              : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
