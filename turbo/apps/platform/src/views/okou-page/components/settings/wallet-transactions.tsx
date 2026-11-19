import type {
  WalletPurchaseHistoryEntry,
  WalletTransaction,
} from "@okouai/api-contracts/contracts/wallet";
import { Badge, cn } from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { useLastLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../../../i18n/index.ts";
import { walletTransactions$ } from "../../../../signals/okou-page/settings/wallet.ts";

function TransactionStatus({
  status,
}: {
  readonly status: WalletPurchaseHistoryEntry["status"];
}) {
  const { t } = useTranslation();
  const labels = {
    creating: t(($) => {
      return $.settings.wallet.transactions.status.creating;
    }),
    created: t(($) => {
      return $.settings.wallet.transactions.status.created;
    }),
    pending_approval: t(($) => {
      return $.settings.wallet.transactions.status.pending_approval;
    }),
    requires_action: t(($) => {
      return $.settings.wallet.transactions.status.requires_action;
    }),
    approved: t(($) => {
      return $.settings.wallet.transactions.status.approved;
    }),
    submitted: t(($) => {
      return $.settings.wallet.transactions.status.submitted;
    }),
    succeeded: t(($) => {
      return $.settings.wallet.transactions.status.succeeded;
    }),
    failed: t(($) => {
      return $.settings.wallet.transactions.status.failed;
    }),
    denied: t(($) => {
      return $.settings.wallet.transactions.status.denied;
    }),
    expired: t(($) => {
      return $.settings.wallet.transactions.status.expired;
    }),
    canceled: t(($) => {
      return $.settings.wallet.transactions.status.canceled;
    }),
  };
  return (
    <Badge
      className={cn(
        "text-xs text-muted-foreground",
        status === "succeeded" && "text-emerald-600 dark:text-emerald-400",
        (status === "failed" || status === "denied") && "text-destructive",
        (status === "pending_approval" || status === "requires_action") &&
          "text-amber-600 dark:text-amber-400",
      )}
    >
      {labels[status]}
    </Badge>
  );
}

const HEADER_CELL =
  "border-b border-b-gray-400 py-3 pr-6 font-medium last:pr-0";
const BODY_CELL = "py-3 pr-6 last:pr-0";

function LinkTransactionStatus({ status }: { readonly status: string }) {
  const { t } = useTranslation();
  const succeeded = ["posted", "succeeded", "completed", "settled"].includes(
    status,
  );
  const failed = ["failed", "declined"].includes(status);
  const label = succeeded
    ? t(($) => {
        return $.settings.wallet.transactions.status.succeeded;
      })
    : failed
      ? t(($) => {
          return $.settings.wallet.transactions.status.failed;
        })
      : status === "pending" ||
          status === "processing" ||
          status === "submitted"
        ? t(($) => {
            return $.settings.wallet.transactions.status.submitted;
          })
        : status === "canceled" || status === "cancelled"
          ? t(($) => {
              return $.settings.wallet.transactions.status.canceled;
            })
          : status === "refunded"
            ? t(($) => {
                return $.settings.wallet.transactions.refunded;
              })
            : t(($) => {
                return $.settings.wallet.transactions.unknownStatus;
              });
  return (
    <Badge
      className={cn(
        "text-xs text-muted-foreground",
        succeeded && "text-emerald-600 dark:text-emerald-400",
        failed && "text-destructive",
      )}
    >
      {label}
    </Badge>
  );
}

function TransactionRow({
  transaction,
}: {
  readonly transaction: WalletPurchaseHistoryEntry | WalletTransaction;
}) {
  const request = "merchantName" in transaction;
  const date = request ? transaction.createdAt : transaction.date;
  const formatter = new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: transaction.currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
  if (fractionDigits === undefined) {
    throw new Error("Currency formatting requires minor-unit precision");
  }
  return (
    <tr>
      <td className={BODY_CELL}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate font-medium text-foreground">
            {request ? transaction.merchantName : transaction.description}
          </span>
        </div>
      </td>
      <td className={cn(BODY_CELL, "tabular-nums text-muted-foreground")}>
        <time dateTime={date}>
          {new Date(date).toLocaleDateString(
            currentLocale(),
            request ? undefined : { timeZone: "UTC" },
          )}
        </time>
      </td>
      <td className={cn(BODY_CELL, "tabular-nums text-foreground")}>
        {formatter.format(transaction.amount / 10 ** fractionDigits)}
      </td>
      <td className={BODY_CELL}>
        {request ? (
          <TransactionStatus status={transaction.status} />
        ) : (
          <LinkTransactionStatus status={transaction.status} />
        )}
      </td>
    </tr>
  );
}

export function WalletTransactions() {
  const { t } = useTranslation();
  const transactions = useLastLoadable(walletTransactions$);
  const data = transactions.state === "hasData" ? transactions.data : null;
  const loading = transactions.state === "loading";
  const requests = data?.source === "requests";
  const title = requests
    ? t(($) => {
        return $.settings.wallet.transactions.requestsTitle;
      })
    : t(($) => {
        return $.settings.wallet.transactions.title;
      });
  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="shrink-0">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {requests
            ? t(($) => {
                return $.settings.wallet.transactions.requestsDescription;
              })
            : t(($) => {
                return $.settings.wallet.transactions.description;
              })}
        </p>
      </div>
      {transactions.state === "hasError" ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.settings.wallet.transactions.loadError;
            })}
          </p>
        </div>
      ) : !loading && !data?.transactions.length ? (
        <p className="text-sm text-muted-foreground">
          {requests
            ? t(($) => {
                return $.settings.wallet.transactions.requestsEmpty;
              })
            : t(($) => {
                return $.settings.wallet.transactions.empty;
              })}
        </p>
      ) : (
        <div className="isolate min-h-0 overflow-auto scroll-pt-12 rounded-[10px] border border-surface-border bg-card">
          {loading && (
            <span role="status" className="sr-only">
              {t(($) => {
                return $.settings.wallet.transactions.loading;
              })}
            </span>
          )}
          <div className="min-w-[40rem] px-4">
            <table
              aria-label={title}
              aria-busy={loading}
              className="w-full table-fixed border-separate border-spacing-0 text-left text-sm"
            >
              <thead className="sticky top-0 z-10 bg-card text-foreground">
                <tr>
                  <th scope="col" className={HEADER_CELL}>
                    {t(($) => {
                      return $.settings.wallet.transactions.merchant;
                    })}
                  </th>
                  <th scope="col" className={cn(HEADER_CELL, "w-28")}>
                    {t(($) => {
                      return $.billing.invoices.date;
                    })}
                  </th>
                  <th scope="col" className={cn(HEADER_CELL, "w-24")}>
                    {t(($) => {
                      return $.billing.invoices.amount;
                    })}
                  </th>
                  <th scope="col" className={cn(HEADER_CELL, "w-52")}>
                    {t(($) => {
                      return $.settings.wallet.transactions.statusLabel;
                    })}
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr+tr>td]:border-t [&>tr+tr>td]:border-t-gray-400">
                {loading
                  ? [0, 1, 2].map((row) => {
                      return (
                        <tr key={row} aria-hidden="true">
                          {[0, 1, 2, 3].map((cell) => {
                            return (
                              <td key={cell} className={BODY_CELL}>
                                <Skeleton className="h-5 w-full rounded" />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })
                  : data?.transactions.map((transaction) => {
                      return (
                        <TransactionRow
                          key={transaction.id}
                          transaction={transaction}
                        />
                      );
                    })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
