import { useGet, useLoadable } from "ccstate-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import {
  ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS,
  accountMenuSubscriptionUsageRowsRefreshPromise$,
  accountMenuSubscriptionUsageRowsCache$,
  accountMenuSubscriptionUsageWindows,
  type AccountMenuSubscriptionUsage,
  type AccountMenuSubscriptionUsageRow,
  type AccountMenuSubscriptionUsageWindow,
  type AccountMenuSubscriptionUsageRowsCacheKey,
} from "../../signals/okou-page/account-menu-subscriptions.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import { formatCodexResetCredits } from "./components/preferences/codex-reset-usage-dialog.tsx";
import {
  formatCodexResetCreditExpiry,
  formatSubscriptionUsageReset,
} from "./subscription-usage-format.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";

type SubscriptionUsage = AccountMenuSubscriptionUsage;
type SubscriptionUsageWindow = AccountMenuSubscriptionUsageWindow;

export function useSubscriptionUsageRows({
  cacheKey,
}: {
  readonly cacheKey: AccountMenuSubscriptionUsageRowsCacheKey;
}) {
  const rowsCache = useGet(accountMenuSubscriptionUsageRowsCache$);
  const refreshLoadable = useLoadable(
    accountMenuSubscriptionUsageRowsRefreshPromise$,
  );
  const cachedRows =
    cacheKey !== null && rowsCache.key === cacheKey ? rowsCache.rows : null;
  const hasCachedRows = cachedRows !== null;
  const loading = refreshLoadable.state === "loading" && !hasCachedRows;
  const rows = cachedRows ?? [];

  return { loading, rows };
}

export function AccountMenuSubscriptionsPanel({
  loading,
  rows,
  onResetCodexUsage,
  resetPending = false,
}: {
  readonly loading: boolean;
  readonly rows: readonly AccountMenuSubscriptionUsageRow[];
  readonly onResetCodexUsage?: (resetCredits: number | null) => void;
  readonly resetPending?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="account-menu-subscriptions" className="px-3 py-2.5">
      {loading && rows.length === 0 ? (
        <AccountMenuSubscriptionsSkeleton />
      ) : (
        <TooltipProvider delayDuration={100}>
          <div className="flex flex-col gap-2.5">
            {rows.map((row, index) => {
              const label =
                row.type === "codex-oauth-token"
                  ? t(($) => {
                      return $.settings.accountMenu.subscriptions.providers
                        .codex;
                    })
                  : t(($) => {
                      return $.settings.accountMenu.subscriptions.providers
                        .claudeCode;
                    });
              return (
                <AccountMenuSubscriptionProviderSection
                  key={row.type}
                  divided={index > 0}
                  type={row.type}
                  label={label}
                  usage={row.usage}
                  resetCredits={row.resetCredits}
                  resetCreditsNextExpiresAt={row.resetCreditsNextExpiresAt}
                  resetPending={resetPending}
                  onResetCodexUsage={onResetCodexUsage}
                />
              );
            })}
          </div>
        </TooltipProvider>
      )}
    </div>
  );
}

function AccountMenuSubscriptionsSkeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-hidden="true">
      {ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS.map((provider, index) => {
        return (
          <div key={provider.type} className="flex flex-col gap-1.5">
            {index > 0 && <div className="-mx-3 h-px bg-divider" />}
            <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
            {["fiveHour", "week"].map((kind) => {
              return (
                <div
                  key={kind}
                  className="grid grid-cols-[34px_minmax(0,1fr)_34px] items-center gap-1.5"
                >
                  <div className="h-2.5 animate-pulse rounded bg-muted/60" />
                  <div className="h-1.5 animate-pulse rounded-full bg-muted/60" />
                  <div className="h-2.5 animate-pulse rounded bg-muted/60" />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function AccountMenuSubscriptionProviderSection({
  divided,
  type,
  label,
  usage,
  resetCredits,
  resetCreditsNextExpiresAt,
  resetPending,
  onResetCodexUsage,
}: {
  readonly divided: boolean;
  readonly type: AccountMenuSubscriptionUsageRow["type"];
  readonly label: string;
  readonly usage: SubscriptionUsage;
  readonly resetCredits?: number | null;
  readonly resetCreditsNextExpiresAt?: string | null;
  readonly resetPending: boolean;
  readonly onResetCodexUsage?: (resetCredits: number | null) => void;
}) {
  const { t } = useTranslation();
  const windows = accountMenuSubscriptionUsageWindows(usage);
  const resetExpiry = formatCodexResetCreditExpiry(
    (resetCredits ?? 0) > 0 ? resetCreditsNextExpiresAt : null,
  );
  const canResetCodex =
    type === "codex-oauth-token" &&
    onResetCodexUsage !== undefined &&
    resetCredits !== null &&
    resetCredits !== undefined &&
    resetCredits > 0;

  return (
    <section
      className="flex flex-col gap-1.5"
      aria-label={t(
        ($) => {
          return $.settings.accountMenu.subscriptions.usage;
        },
        { provider: label },
      )}
    >
      {divided && <div className="-mx-3 h-px bg-divider" />}
      <h3 className="truncate text-xs font-medium leading-4 text-foreground">
        {label}
      </h3>
      <div className="flex flex-col gap-1">
        {windows.map(({ kind, window }) => {
          const windowLabel =
            kind === "fiveHour"
              ? t(($) => {
                  return $.settings.accountMenu.subscriptions.windows.fiveHour;
                })
              : t(($) => {
                  return $.settings.accountMenu.subscriptions.windows.week;
                });
          return (
            <AccountMenuSubscriptionUsageBar
              key={kind}
              providerLabel={label}
              windowLabel={windowLabel}
              window={window}
            />
          );
        })}
      </div>
      {type === "codex-oauth-token" ? (
        <DropdownMenuModalItem
          disabled={!canResetCodex || resetPending}
          onModalSelect={() => {
            onResetCodexUsage?.(resetCredits ?? null);
          }}
          className="mt-1 flex items-center justify-between gap-2 rounded-md px-2 text-xs"
        >
          <ResetCreditsLabel
            resetCredits={resetCredits}
            resetCreditsNextExpiresAt={resetCreditsNextExpiresAt}
            expiryTooltip={resetExpiry?.absoluteText ?? null}
          />
          <span className="shrink-0 font-medium text-foreground">
            {t(($) => {
              return $.settings.accountMenu.subscriptions.reset;
            })}
          </span>
        </DropdownMenuModalItem>
      ) : null}
    </section>
  );
}

function ResetCreditsLabel({
  resetCredits,
  resetCreditsNextExpiresAt,
  expiryTooltip,
}: {
  readonly resetCredits?: number | null;
  readonly resetCreditsNextExpiresAt?: string | null;
  readonly expiryTooltip: string | null;
}) {
  const { t } = useTranslation();
  // The menu is narrow enough that the inline deadline truncates, so the exact
  // date stays reachable through the tooltip.
  const label = (
    <span className="min-w-0 flex-1 truncate text-muted-foreground">
      {formatCodexResetCredits(resetCredits, resetCreditsNextExpiresAt)}
    </span>
  );

  if (!expiryTooltip) {
    return label;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent>
        {t(
          ($) => {
            return $.settings.models.reset.expiresAt;
          },
          { date: expiryTooltip },
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function AccountMenuSubscriptionUsageBar({
  providerLabel,
  windowLabel,
  window,
}: {
  readonly providerLabel: string;
  readonly windowLabel: string;
  readonly window: SubscriptionUsageWindow;
}) {
  const { t } = useTranslation();
  const rawRemainingPercent =
    window.remainingPercent ??
    (window.usedPercent === null ? null : 100 - window.usedPercent);
  const remainingPercent =
    rawRemainingPercent !== null && Number.isFinite(rawRemainingPercent)
      ? rawRemainingPercent
      : null;
  const displayPercent = formatUsagePercent(remainingPercent);
  const reset = formatSubscriptionUsageReset(window.resetAt);
  const tone = usageTone(remainingPercent);
  const width =
    remainingPercent === null
      ? 0
      : Math.min(100, Math.max(0, remainingPercent));

  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)_34px] items-center gap-1.5">
      <span className="truncate text-[10px] font-medium leading-none text-muted-foreground">
        {windowLabel}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="progressbar"
            aria-label={t(
              ($) => {
                return $.settings.accountMenu.subscriptions.usageRemaining;
              },
              { provider: providerLabel, window: windowLabel },
            )}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remainingPercent ?? undefined}
            className={`block h-1.5 min-w-0 overflow-hidden rounded-full outline-none ring-offset-1 ring-offset-popover transition-shadow focus-visible:ring-2 focus-visible:ring-ring ${tone.trackClassName}`}
          >
            <span
              className={`block h-full rounded-full transition-[width] ${tone.barClassName}`}
              style={{ width: `${width}%` }}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" align="center" className="max-w-56">
          {reset === null ? (
            <p className="text-xs">
              {t(($) => {
                return $.settings.accountMenu.subscriptions
                  .resetTimeUnavailable;
              })}
            </p>
          ) : "fallbackText" in reset ? (
            <p className="text-xs">{reset.fallbackText}</p>
          ) : (
            <div className="space-y-0.5">
              <p className="text-xs font-medium">{reset.tooltipTitle}</p>
              <p className="text-[10px] text-muted-foreground">
                {reset.absoluteText}
              </p>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      <span
        className={`text-right text-[10px] font-medium leading-none ${tone.textClassName}`}
      >
        {displayPercent ?? "--"}
      </span>
    </div>
  );
}

function formatUsagePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  return formatLocalizedNumber(rounded / 100, {
    style: "percent",
    maximumFractionDigits: 1,
  });
}

function usageTone(remainingPercent: number | null): {
  readonly barClassName: string;
  readonly textClassName: string;
  readonly trackClassName: string;
} {
  if (remainingPercent !== null && remainingPercent < 20) {
    return {
      barClassName: "bg-red-500",
      textClassName: "text-red-600 dark:text-red-400",
      trackClassName: "bg-red-500/15",
    };
  }
  if (remainingPercent !== null && remainingPercent < 50) {
    return {
      barClassName: "bg-amber-500",
      textClassName: "text-amber-600 dark:text-amber-400",
      trackClassName: "bg-amber-500/15",
    };
  }
  return {
    barClassName: "bg-emerald-500",
    textClassName: "text-emerald-600 dark:text-emerald-400",
    trackClassName: "bg-emerald-500/15",
  };
}
