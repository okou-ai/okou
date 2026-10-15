import type { WalletPurchaseHistoryEntry } from "@okouai/api-contracts/contracts/wallet";
import { Badge, Button, cn } from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../../../i18n/index.ts";
import { formatUsd } from "../../../../i18n/format.ts";
import {
  nextWalletTransactionPage$,
  previousWalletTransactionPage$,
  refreshWalletTransactions$,
  walletTransactionPage$,
  walletTransactions$,
} from "../../../../signals/okou-page/settings/wallet.ts";

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

function TransactionRow({
  transaction,
}: {
  readonly transaction: WalletPurchaseHistoryEntry;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 py-4 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words text-sm font-medium text-foreground">
            {transaction.merchantName}
          </span>
          {transaction.test && (
            <Badge className="text-xs text-muted-foreground">
              {t(($) => {
                return $.settings.wallet.transactions.test;
              })}
            </Badge>
          )}
        </div>
        <time
          dateTime={transaction.createdAt}
          className="mt-1 block text-xs text-muted-foreground"
        >
          {new Intl.DateTimeFormat(currentLocale(), {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(transaction.createdAt))}
        </time>
      </div>
      <div className="flex max-w-full flex-col items-end gap-1.5 text-right">
        <span className="text-sm font-medium tabular-nums text-foreground">
          {formatUsd(transaction.amount / 100)}
        </span>
        <TransactionStatus status={transaction.status} />
      </div>
    </li>
  );
}

export function WalletTransactions() {
  const { t } = useTranslation();
  const transactions = useLoadable(walletTransactions$);
  const page = useGet(walletTransactionPage$);
  const next = useSet(nextWalletTransactionPage$);
  const previous = useSet(previousWalletTransactionPage$);
  const refresh = useSet(refreshWalletTransactions$);
  const data = transactions.state === "hasData" ? transactions.data : null;
  const loading = transactions.state === "loading";
  const title = t(($) => {
    return $.settings.wallet.transactions.title;
  });
  return (
    <section aria-label={title}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.wallet.transactions.description;
            })}
          </p>
        </div>
        <Button
          showTooltip
          variant="quiet"
          size="icon"
          disabled={loading}
          aria-label={t(($) => {
            return $.settings.wallet.transactions.refresh;
          })}
          onClick={() => {
            refresh();
          }}
        >
          <RefreshCw size={16} />
        </Button>
      </div>
      {loading ? (
        <div
          role="status"
          aria-label={t(($) => {
            return $.settings.wallet.transactions.loading;
          })}
          className="mt-3 space-y-3"
        >
          {[0, 1, 2].map((row) => {
            return <Skeleton key={row} className="h-14 w-full rounded-lg" />;
          })}
        </div>
      ) : transactions.state === "hasError" ? (
        <div className="mt-4 flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.settings.wallet.transactions.loadError;
            })}
          </p>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              refresh();
            }}
          >
            {t(($) => {
              return $.settings.wallet.retry;
            })}
          </Button>
        </div>
      ) : data?.transactions.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.wallet.transactions.empty;
          })}
        </p>
      ) : (
        <ul aria-label={title} className="mt-3">
          {data?.transactions.map((transaction) => {
            return (
              <TransactionRow key={transaction.id} transaction={transaction} />
            );
          })}
        </ul>
      )}
      {(page > 1 || data?.nextCursor) && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t(
              ($) => {
                return $.settings.wallet.transactions.page;
              },
              { value: page },
            )}
          </span>
          <div className="flex gap-2">
            <Button
              variant="neutral"
              size="sm"
              disabled={loading || page === 1}
              onClick={() => {
                previous();
              }}
            >
              {t(($) => {
                return $.settings.wallet.transactions.previous;
              })}
            </Button>
            <Button
              variant="neutral"
              size="sm"
              disabled={loading || !data?.nextCursor}
              onClick={() => {
                if (data?.nextCursor) {
                  next(data.nextCursor);
                }
              }}
            >
              {t(($) => {
                return $.settings.wallet.transactions.next;
              })}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
