import type { WalletPaymentMethod } from "@okouai/api-contracts/contracts/wallet";
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  surfaceVariants,
} from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { useLastLoadable, useSet } from "ccstate-react";
import { Check, CreditCard, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  refreshWalletCards$,
  walletCards$,
} from "../../../../signals/okou-page/settings/wallet.ts";

function WalletCardRow({ method }: { readonly method: WalletPaymentMethod }) {
  const { t } = useTranslation();
  const card = method.card;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-4">
      <div className="flex h-9 w-12 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-gray-50 text-muted-foreground">
        <CreditCard size={20} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words text-sm font-medium text-foreground">
            {method.nickname || method.name}
          </span>
          {method.isDefault && (
            <Badge className="text-xs text-muted-foreground">
              <Check aria-hidden="true" />
              {t(($) => {
                return $.settings.wallet.cards.default;
              })}
            </Badge>
          )}
        </div>
        {card && (
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="capitalize">{card.brand}</span>
            {" ···· "}
            {card.last4}
          </p>
        )}
      </div>
      {card && (
        <span className="w-full pl-15 text-sm tabular-nums text-muted-foreground sm:w-auto sm:pl-0">
          {t(
            ($) => {
              return $.settings.wallet.cards.expires;
            },
            {
              date: `${String(card.expMonth).padStart(2, "0")}/${card.expYear}`,
            },
          )}
        </span>
      )}
    </li>
  );
}

export function WalletCards() {
  const { t } = useTranslation();
  const cards = useLastLoadable(walletCards$);
  const retry = useSet(refreshWalletCards$);
  const title = t(($) => {
    return $.settings.wallet.cards.title;
  });
  return (
    <Card
      role="region"
      aria-label={title}
      className={surfaceVariants({ className: "shrink-0" })}
    >
      <div className="px-5 pt-5 pb-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.wallet.cards.description;
          })}
        </p>
      </div>
      {cards.state === "loading" ? (
        <div role="status" className="space-y-3 px-5 py-4">
          <span className="sr-only">
            {t(($) => {
              return $.settings.wallet.cards.loading;
            })}
          </span>
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : cards.state === "hasError" ? (
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.settings.wallet.cards.loadError;
            })}
          </p>
          <Button variant="quiet" size="sm" onClick={retry}>
            {t(($) => {
              return $.settings.wallet.retry;
            })}
          </Button>
        </div>
      ) : cards.data.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.wallet.cards.empty;
          })}
        </p>
      ) : (
        <ul aria-label={title} className="divide-y divide-gray-400">
          {cards.data.map((method) => {
            return <WalletCardRow key={method.id} method={method} />;
          })}
        </ul>
      )}
      <div className="flex justify-end border-t border-t-gray-400 px-5 py-4">
        <a
          href="https://app.link.com/wallet"
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants()}
        >
          {t(($) => {
            return $.settings.wallet.cards.manage;
          })}
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      </div>
    </Card>
  );
}
