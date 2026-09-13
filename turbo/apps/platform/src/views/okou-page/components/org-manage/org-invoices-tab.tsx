import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { CircleCheck, Download } from "lucide-react";
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Badge,
} from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import type { FormEvent } from "react";
import {
  downloadMonthlyReceipts$,
  initializeReceiptDownloadRange$,
  invoicesAsync$,
  receiptDownloadRange$,
  receiptDownloadRangeExceedsLimit$,
  setReceiptDownloadEndMonth$,
  setReceiptDownloadStartMonth$,
} from "../../../../signals/okou-page/billing.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { currentLocale } from "../../../../i18n/index.ts";
import { formatUsd } from "../../../../i18n/format.ts";

const cardBorder = {
  border: "var(--border-width-surface) solid hsl(var(--gray-400))",
} as const;

const ROW_GRID = "grid grid-cols-[1fr_8rem_6rem_3rem] gap-x-6 items-center";

function formatDate(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toLocaleDateString(currentLocale());
}

function formatAmount(cents: number): string {
  return formatUsd(cents / 100);
}

function formatInvoiceMonth(unixTimestamp: number): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "long",
    year: "numeric",
  }).format(new Date(unixTimestamp * 1000));
}

interface InvoiceMonth {
  readonly value: string;
  readonly label: string;
}

function invoiceMonths(invoices: readonly { readonly date: number }[]) {
  const months = new Map<string, InvoiceMonth>();
  for (const invoice of invoices) {
    const date = new Date(invoice.date * 1000);
    const value = `${date.getUTCFullYear()}-${String(
      date.getUTCMonth() + 1,
    ).padStart(2, "0")}`;
    months.set(value, {
      value,
      label: new Intl.DateTimeFormat(currentLocale(), {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(date),
    });
  }
  return [...months.values()].sort((left, right) => {
    return right.value.localeCompare(left.value);
  });
}

function InvoiceRowsSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.billing.invoices.loading;
      })}
      data-testid="invoice-list-skeleton"
    >
      {[0, 1, 2].map((row) => {
        return (
          <div key={row}>
            {row > 0 && <div className="h-0 border-t border-t-gray-400 mx-4" />}
            <div className={cn(ROW_GRID, "px-4 py-3")}>
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-14 rounded-lg" />
              </div>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-14" />
              <div className="flex justify-end">
                <Skeleton className="h-7 w-7 rounded-lg" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReceiptMonthSelect({
  id,
  label,
  name,
  value,
  months,
  onValueChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly months: readonly InvoiceMonth[];
  readonly onValueChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="grid gap-1.5 text-sm" htmlFor={id}>
      <span className="font-medium text-foreground">{label}</span>
      <Select name={name} value={value} onValueChange={onValueChange}>
        <SelectTrigger
          id={id}
          aria-label={t(
            ($) => {
              return $.billing.invoices.monthAria;
            },
            { label },
          )}
          className="h-9 w-full"
        >
          <SelectValue
            placeholder={t(($) => {
              return $.billing.invoices.selectMonth;
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {months.map((month) => {
            return (
              <SelectItem key={month.value} value={month.value}>
                {month.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

function DownloadReceiptsDialog({
  months,
}: {
  readonly months: readonly InvoiceMonth[];
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [downloadLoadable, downloadReceipts] = useLoadableSet(
    downloadMonthlyReceipts$,
  );
  const range = useGet(receiptDownloadRange$);
  const rangeExceedsLimit = useGet(receiptDownloadRangeExceedsLimit$);
  const initializeRange = useSet(initializeReceiptDownloadRange$);
  const setStartMonth = useSet(setReceiptDownloadStartMonth$);
  const setEndMonth = useSet(setReceiptDownloadEndMonth$);
  const downloading = downloadLoadable.state === "loading";
  const defaultMonth = months[0]?.value;
  const canSubmit =
    !downloading &&
    !rangeExceedsLimit &&
    range.startMonth !== "" &&
    range.endMonth !== "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    const [startMonth, endMonth] =
      range.startMonth <= range.endMonth
        ? [range.startMonth, range.endMonth]
        : [range.endMonth, range.startMonth];
    detach(
      downloadReceipts({ startMonth, endMonth }, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open && defaultMonth) {
          initializeRange(defaultMonth);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={downloading}
        >
          <Download size={14} />
          {downloading
            ? t(($) => {
                return $.billing.invoices.preparingReceipts;
              })
            : t(($) => {
                return $.billing.invoices.downloadReceipts;
              })}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {t(($) => {
                return $.billing.invoices.downloadReceipts;
              })}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.billing.invoices.downloadDescription;
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-5">
            <ReceiptMonthSelect
              id="receipt-start-month"
              label={t(($) => {
                return $.billing.invoices.from;
              })}
              name="startMonth"
              value={range.startMonth}
              months={months}
              onValueChange={setStartMonth}
            />
            <ReceiptMonthSelect
              id="receipt-end-month"
              label={t(($) => {
                return $.billing.invoices.to;
              })}
              name="endMonth"
              value={range.endMonth}
              months={months}
              onValueChange={setEndMonth}
            />
          </div>
          {rangeExceedsLimit && (
            <p role="alert" className="-mt-2 pb-5 text-sm text-destructive">
              {t(($) => {
                return $.billing.invoices.rangeError;
              })}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t(($) => {
                  return $.billing.common.cancel;
                })}
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button type="submit" disabled={!canSubmit}>
                {t(($) => {
                  return $.billing.invoices.downloadZip;
                })}
              </Button>
            </DialogClose>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OrgInvoicesTab() {
  const { t } = useTranslation();
  const invoicesLoadable = useLastLoadable(invoicesAsync$);
  const loading = invoicesLoadable.state === "loading";

  const invoices =
    invoicesLoadable.state === "hasData" ? invoicesLoadable.data.invoices : [];
  const receiptDownloadsSupported =
    invoicesLoadable.state === "hasData" &&
    invoicesLoadable.data.receiptDownloadsSupported === true;
  const months = invoiceMonths(invoices);

  if (!loading && invoices.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.billing.invoices.empty;
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!loading && receiptDownloadsSupported && (
        <div className="flex justify-end">
          <DownloadReceiptsDialog months={months} />
        </div>
      )}
      <div
        className="overflow-hidden rounded-[10px] bg-card"
        style={cardBorder}
      >
        <div
          className={cn(
            ROW_GRID,
            "sticky top-0 z-10 px-4 py-3 text-sm font-medium text-foreground bg-card",
          )}
        >
          <div className="text-left">
            {t(($) => {
              return $.billing.invoices.invoice;
            })}
          </div>
          <div className="text-left">
            {t(($) => {
              return $.billing.invoices.date;
            })}
          </div>
          <div className="text-left">
            {t(($) => {
              return $.billing.invoices.amount;
            })}
          </div>
          <div />
        </div>
        <div className="h-0 border-t border-t-gray-400 mx-4" />

        {loading && <InvoiceRowsSkeleton />}

        {invoices.map((inv, i) => {
          const invoiceMonth = formatInvoiceMonth(inv.date);
          return (
            <div key={inv.id}>
              {i > 0 && <div className="h-0 border-t border-t-gray-400 mx-4" />}
              <div className={cn(ROW_GRID, "px-4 py-3")}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-foreground truncate">
                    {inv.number ?? inv.id}
                  </span>
                  {inv.status && (
                    <Badge className="text-xs font-medium text-muted-foreground">
                      <CircleCheck className="text-green-600" />
                      {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                    </Badge>
                  )}
                </div>
                <div className="text-left text-sm text-muted-foreground tabular-nums">
                  {formatDate(inv.date)}
                </div>
                <div className="text-left text-sm text-foreground tabular-nums">
                  {formatAmount(inv.amount)}
                </div>
                <div className="flex justify-end">
                  {inv.hostedInvoiceUrl ? (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a
                            href={inv.hostedInvoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-state-hover transition-colors"
                            aria-label={t(
                              ($) => {
                                return $.billing.invoices.downloadInvoice;
                              },
                              { month: invoiceMonth },
                            )}
                          >
                            <Download size={14} />
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          <p className="text-xs">
                            {t(
                              ($) => {
                                return $.billing.invoices.downloadInvoice;
                              },
                              { month: invoiceMonth },
                            )}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center text-muted-foreground/30">
                      <Download size={14} />
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
