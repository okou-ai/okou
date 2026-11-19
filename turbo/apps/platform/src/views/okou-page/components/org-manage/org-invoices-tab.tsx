import { useLastLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { CircleCheck, Download } from "lucide-react";
import {
  cn,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Badge,
} from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { invoicesAsync$ } from "../../../../signals/okou-page/billing.ts";
import { currentLocale } from "../../../../i18n/index.ts";
import { formatUsd } from "../../../../i18n/format.ts";

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

function InvoiceListHeader() {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-10 bg-card">
      <div
        className={cn(
          ROW_GRID,
          "px-4 py-3 text-sm font-medium text-foreground",
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
    </div>
  );
}

export function OrgInvoicesTab() {
  const { t } = useTranslation();
  const invoicesLoadable = useLastLoadable(invoicesAsync$);
  const loading = invoicesLoadable.state === "loading";

  const invoices =
    invoicesLoadable.state === "hasData" ? invoicesLoadable.data.invoices : [];

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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Own scrolling and confine the header's overlap to the invoice rows. */}
      <div className="isolate min-h-0 overflow-auto scroll-pt-12 rounded-[10px] bg-card border border-surface-border">
        <div className="min-w-[36rem]">
          <InvoiceListHeader />

          {loading && <InvoiceRowsSkeleton />}

          {invoices.map((inv, i) => {
            const invoiceMonth = formatInvoiceMonth(inv.date);
            return (
              <div key={inv.id}>
                {i > 0 && (
                  <div className="h-0 border-t border-t-gray-400 mx-4" />
                )}
                <div className={cn(ROW_GRID, "px-4 py-3")}>
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">
                      {inv.number ?? inv.id}
                    </span>
                    {inv.status && (
                      <Badge className="text-xs font-medium text-muted-foreground">
                        <CircleCheck className="text-green-600" />
                        {inv.status.charAt(0).toUpperCase() +
                          inv.status.slice(1)}
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
                      <TooltipProvider delay={200}>
                        <Tooltip>
                          <TooltipTrigger
                            render={
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
                            }
                          />
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
    </div>
  );
}
