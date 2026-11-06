import { useGet, useLoadable } from "ccstate-react";
import {
  Button,
  DropdownMenuItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { ChevronRight, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS,
  accountMenuSubscriptionUsageRowsRefreshPromise$,
  accountMenuSubscriptionUsageRowsCache$,
  type AccountMenuSubscriptionUsageRow,
  type AccountMenuSubscriptionUsageWindow,
  type AccountMenuSubscriptionUsageRowsCacheKey,
} from "../../signals/okou-page/account-menu-subscriptions.ts";
import {
  subscriptionUsageWindowRemainingPercent,
  subscriptionUsageWindows,
} from "../../lib/subscription-usage-windows.ts";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";
import { formatSubscriptionUsageReset } from "./subscription-usage-format.ts";
import { formatSubscriptionCredits } from "./subscription-credits-format.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";

type SubscriptionUsageWindow = AccountMenuSubscriptionUsageWindow;

/** Below this much left, a window uses the low-usage color. */
const LOW_REMAINING_PERCENT = 20;

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
  onOpenUsage,
  resetPending = false,
  resetControl = "menu",
}: {
  readonly loading: boolean;
  readonly rows: readonly AccountMenuSubscriptionUsageRow[];
  readonly onResetCodexUsage?: (resetCredits: number | null) => void;
  readonly onOpenUsage?: () => void;
  readonly resetPending?: boolean;
  readonly resetControl?: "menu" | "button";
}) {
  return (
    <div data-testid="account-menu-subscriptions">
      {loading && rows.length === 0 ? (
        <AccountMenuSubscriptionsSkeleton />
      ) : (
        <TooltipProvider delay={250}>
          <div
            className={cn("flex flex-col", resetControl === "menu" && "gap-1")}
          >
            {rows.map((row) => {
              return (
                <AccountMenuSubscriptionProviderSection
                  key={row.type}
                  row={row}
                  resetPending={resetPending}
                  resetControl={resetControl}
                  onResetCodexUsage={onResetCodexUsage}
                  onOpenUsage={onOpenUsage}
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
    <div className="flex flex-col gap-1" aria-hidden="true">
      {ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS.map((provider) => {
        return (
          <div
            key={provider.type}
            className="flex flex-col gap-2 rounded-lg bg-nested-fill p-3"
          >
            <div className="flex h-5 items-center">
              <div className="h-3 w-20 animate-skeleton-pulse rounded bg-skeleton" />
            </div>
            {(provider.type === "codex-oauth-token"
              ? ["week"]
              : ["fiveHour", "week"]
            ).map((kind) => {
              return (
                <div key={kind} className="flex flex-col gap-1">
                  <div className="flex h-5 items-center justify-between">
                    <div className="h-3 w-20 animate-skeleton-pulse rounded bg-skeleton" />
                    <div className="h-3 w-14 animate-skeleton-pulse rounded bg-skeleton" />
                  </div>
                  <div className="h-1 animate-skeleton-pulse rounded-full bg-skeleton" />
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
  row,
  resetPending,
  resetControl,
  onResetCodexUsage,
  onOpenUsage,
}: {
  readonly row: AccountMenuSubscriptionUsageRow;
  readonly resetPending: boolean;
  readonly resetControl: "menu" | "button";
  readonly onResetCodexUsage?: (resetCredits: number | null) => void;
  readonly onOpenUsage?: () => void;
}) {
  const { t } = useTranslation();
  const isCodex = row.type === "codex-oauth-token";
  const label = isCodex ? "ChatGPT" : "Claude";
  const windows = subscriptionUsageWindows(row.usage).filter(({ kind }) => {
    return !isCodex || kind === "week";
  });
  const weekly = windows.find(({ kind }) => {
    return kind === "week";
  });
  const exhausted =
    isCodex &&
    weekly !== undefined &&
    subscriptionUsageWindowRemainingPercent(weekly.window) === 0;
  const resetCredits = row.resetCredits;
  const canReset =
    exhausted &&
    resetCredits !== null &&
    resetCredits !== undefined &&
    resetCredits > 0 &&
    onResetCodexUsage !== undefined;
  const creditBalance = exhausted
    ? formatSubscriptionCredits({
        type: row.type,
        subscriptionCredits: row.credits,
      })
    : null;
  const windowLabel = (kind: "fiveHour" | "week") => {
    return kind === "fiveHour"
      ? t(($) => {
          return $.settings.accountMenu.subscriptions.fiveHourLimit;
        })
      : t(($) => {
          return $.settings.accountMenu.subscriptions.weeklyLimit;
        });
  };
  const usageLabel = t(
    ($) => {
      return $.settings.accountMenu.subscriptions.usage;
    },
    { provider: label },
  );

  return (
    <section
      className={cn(
        "rounded-lg",
        resetControl === "button"
          ? "not-first:before:mx-3 not-first:before:my-1 not-first:before:block not-first:before:border-t not-first:before:border-border"
          : "overflow-hidden bg-nested-fill",
      )}
      aria-label={usageLabel}
    >
      <Tooltip>
        <TooltipTrigger
          render={subscriptionInformationTarget(resetControl, onOpenUsage)}
          aria-label={usageLabel}
        >
          <SubscriptionProviderHeading
            type={row.type}
            label={label}
            showAction={onOpenUsage !== undefined}
          />
          <div className="flex flex-col gap-2">
            {windows.map(({ kind, window }) => {
              return (
                <AccountMenuSubscriptionUsageBar
                  key={kind}
                  providerLabel={label}
                  windowLabel={windowLabel(kind)}
                  window={window}
                />
              );
            })}
          </div>
          {creditBalance !== null && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {t(($) => {
                  return $.settings.accountMenu.subscriptions.credits;
                })}
              </span>
              <span className="shrink-0 tabular-nums">
                {creditBalance.value}
              </span>
            </div>
          )}
        </TooltipTrigger>
        <SubscriptionResetTimes windows={windows} windowLabel={windowLabel} />
      </Tooltip>
      {canReset && (
        <AccountMenuCodexResetControl
          resetControl={resetControl}
          resetPending={resetPending}
          onReset={() => {
            onResetCodexUsage(resetCredits);
          }}
        />
      )}
    </section>
  );
}

function SubscriptionProviderHeading({
  type,
  label,
  showAction,
}: {
  readonly type: AccountMenuSubscriptionUsageRow["type"];
  readonly label: string;
  readonly showAction: boolean;
}) {
  return (
    <h3 className="flex items-center gap-2 font-medium">
      <ProviderIcon type={type} size={16} />
      {label}
      {showAction && (
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.5}
          className="ml-auto size-4 shrink-0 text-muted-foreground"
        />
      )}
    </h3>
  );
}

function subscriptionInformationTarget(
  resetControl: "menu" | "button",
  onOpenUsage: (() => void) | undefined,
) {
  // This is a multi-line information block; all four sides share 12px padding.
  const informationClassName =
    "flex w-full flex-col items-stretch gap-2 rounded-lg p-3 text-left text-sm font-normal leading-5 outline-none hover:bg-state-hover focus-visible:bg-state-hover";

  if (resetControl === "menu") {
    return (
      <DropdownMenuItem
        closeOnClick={onOpenUsage !== undefined}
        onClick={onOpenUsage}
        className={cn(
          informationClassName,
          onOpenUsage && "active:bg-state-pressed",
        )}
      />
    );
  }

  if (onOpenUsage) {
    return (
      <button
        type="button"
        onClick={onOpenUsage}
        className={cn(informationClassName, "active:bg-state-pressed")}
      />
    );
  }
  return <div tabIndex={0} className={informationClassName} />;
}

function SubscriptionResetTimes({
  windows,
  windowLabel,
}: {
  readonly windows: ReturnType<typeof subscriptionUsageWindows>;
  readonly windowLabel: (kind: "fiveHour" | "week") => string;
}) {
  const { t } = useTranslation();
  return (
    <TooltipContent side="right" sideOffset={10} className="text-sm">
      <div className="space-y-2">
        {windows.length === 0
          ? t(($) => {
              return $.settings.accountMenu.subscriptions.resetTimeUnavailable;
            })
          : windows.map(({ kind, window }) => {
              const reset = formatSubscriptionUsageReset(window.resetAt);
              return (
                <div key={kind} className="space-y-0.5">
                  <div className="flex justify-between gap-4">
                    <span>{windowLabel(kind)}</span>
                    <span>
                      {reset === null
                        ? t(($) => {
                            return $.settings.accountMenu.subscriptions
                              .resetTimeUnavailable;
                          })
                        : "fallbackText" in reset
                          ? reset.fallbackText
                          : reset.tooltipTitle}
                    </span>
                  </div>
                  {reset !== null && !("fallbackText" in reset) && (
                    <p className="text-xs text-on-filled/60">
                      {reset.absoluteText}
                    </p>
                  )}
                </div>
              );
            })}
      </div>
    </TooltipContent>
  );
}

function AccountMenuCodexResetControl({
  resetControl,
  resetPending,
  onReset,
}: {
  readonly resetControl: "menu" | "button";
  readonly resetPending: boolean;
  readonly onReset: () => void;
}) {
  const { t } = useTranslation();
  const resetAction = (
    <>
      <RotateCcw strokeWidth={1.5} />
      {t(($) => {
        return $.settings.models.actions.resetUsage;
      })}
    </>
  );
  return (
    <div className="px-3 pb-3">
      {resetControl === "menu" ? (
        <DropdownMenuItem
          nativeButton
          render={
            <Button
              variant="outline"
              className="w-full justify-center font-normal"
            />
          }
          disabled={resetPending}
          onClick={onReset}
        >
          {resetAction}
        </DropdownMenuItem>
      ) : (
        <Button
          variant="outline"
          className="w-full font-normal"
          disabled={resetPending}
          onClick={onReset}
        >
          {resetAction}
        </Button>
      )}
    </div>
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
  const remainingPercent = subscriptionUsageWindowRemainingPercent(window);
  const displayPercent = formatUsagePercent(remainingPercent);
  const tone = usageTone(remainingPercent);
  const reset =
    remainingPercent === 0
      ? formatSubscriptionUsageReset(window.resetAt)
      : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{windowLabel}</span>
        <span className={cn("shrink-0 tabular-nums", tone.textClassName)}>
          {remainingPercent === 0
            ? t(($) => {
                return $.settings.accountMenu.subscriptions.limitReached;
              })
            : displayPercent === null
              ? "—"
              : t(
                  ($) => {
                    return $.settings.models.personal.status.left;
                  },
                  { percent: displayPercent },
                )}
        </span>
      </div>
      <span
        role="meter"
        aria-label={t(
          ($) => {
            return $.settings.accountMenu.subscriptions.usageRemaining;
          },
          { provider: providerLabel, window: windowLabel },
        )}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent ?? undefined}
        className="flex h-1 min-w-0 gap-0.5 rounded-full"
      >
        <UsageMeterFill
          remainingPercent={remainingPercent}
          fillClassName={tone.fillClassName}
        />
      </span>
      {remainingPercent === 0 && (
        <span className="text-xs text-muted-foreground">
          {reset === null
            ? t(($) => {
                return $.settings.accountMenu.subscriptions
                  .resetTimeUnavailable;
              })
            : "fallbackText" in reset
              ? reset.fallbackText
              : reset.tooltipTitle}
        </span>
      )}
    </div>
  );
}

/** Filled usage is blue or amber; exhausted and unknown usage have an empty track. */
function UsageMeterFill({
  remainingPercent,
  fillClassName,
}: {
  readonly remainingPercent: number | null;
  readonly fillClassName: string;
}) {
  if (remainingPercent === null || remainingPercent <= 0) {
    return (
      <span className="block h-full flex-1 rounded-full bg-segment-track" />
    );
  }
  return (
    <>
      <span
        className={cn("block h-full rounded-full", fillClassName)}
        style={{ width: `${String(remainingPercent)}%` }}
      />
      {remainingPercent < 100 && (
        <span className="block h-full min-w-1 flex-1 rounded-full bg-segment-track" />
      )}
    </>
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

/** Status uses restrained color with no persistent animation. */
function usageTone(remainingPercent: number | null): {
  readonly fillClassName: string;
  readonly textClassName: string;
} {
  if (remainingPercent === null) {
    return { fillClassName: "", textClassName: "text-muted-foreground" };
  }
  if (remainingPercent <= 0) {
    return { fillClassName: "", textClassName: "text-foreground" };
  }
  return {
    fillClassName:
      remainingPercent < LOW_REMAINING_PERCENT
        ? "bg-usage-meter-low"
        : "bg-chart-blue-400",
    textClassName: "text-foreground",
  };
}
