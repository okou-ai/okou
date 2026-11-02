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
import { RotateCcw } from "lucide-react";
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
import { now } from "../../lib/time.ts";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";
import { formatSubscriptionUsageReset } from "./subscription-usage-format.ts";
import { formatSubscriptionCredits } from "./subscription-credits-format.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";

type SubscriptionUsageWindow = AccountMenuSubscriptionUsageWindow;

/** Below this much left, a window turns coral and breathes. */
const LOW_REMAINING_PERCENT = 20;
/** At or below this much left, the breathing doubles its rate. */
const CRITICAL_REMAINING_PERCENT = 5;

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
  resetControl = "menu",
}: {
  readonly loading: boolean;
  readonly rows: readonly AccountMenuSubscriptionUsageRow[];
  readonly onResetCodexUsage?: (resetCredits: number | null) => void;
  readonly resetPending?: boolean;
  readonly resetControl?: "menu" | "button";
}) {
  return (
    <div data-testid="account-menu-subscriptions">
      {loading && rows.length === 0 ? (
        <AccountMenuSubscriptionsSkeleton />
      ) : (
        <TooltipProvider delay={250}>
          <div className="flex flex-col gap-1">
            {rows.map((row) => {
              return (
                <AccountMenuSubscriptionProviderSection
                  key={row.type}
                  row={row}
                  resetPending={resetPending}
                  resetControl={resetControl}
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
}: {
  readonly row: AccountMenuSubscriptionUsageRow;
  readonly resetPending: boolean;
  readonly resetControl: "menu" | "button";
  readonly onResetCodexUsage?: (resetCredits: number | null) => void;
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
  const weeklyReset = exhausted
    ? formatSubscriptionUsageReset(weekly.window.resetAt)
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
  // This is a multi-line information block; all four sides share 12px padding.
  const informationClassName =
    "flex w-full flex-col items-stretch gap-2 rounded-lg p-3 text-sm font-normal leading-5 outline-none hover:bg-state-hover focus-visible:bg-state-hover";

  return (
    <section
      className="overflow-hidden rounded-lg bg-nested-fill"
      aria-label={usageLabel}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            resetControl === "menu" ? (
              <DropdownMenuItem
                closeOnClick={false}
                className={informationClassName}
              />
            ) : (
              <div tabIndex={0} className={informationClassName} />
            )
          }
          aria-label={usageLabel}
        >
          <h3 className="flex items-center gap-2 font-medium">
            <ProviderIcon type={row.type} size={16} />
            {label}
          </h3>
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
          {exhausted && !canReset && weeklyReset !== null && (
            <p className="text-muted-foreground">
              {"fallbackText" in weeklyReset
                ? weeklyReset.fallbackText
                : weeklyReset.tooltipTitle}
            </p>
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
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{windowLabel}</span>
        <span className={cn("shrink-0 tabular-nums", tone.textClassName)}>
          {displayPercent === null
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
          window={window}
          fillClassName={tone.fillClassName}
        />
      </span>
    </div>
  );
}

/**
 * The fill and what is left are two pieces with a 2px gap between them. The
 * healthy gradient spans the whole track rather than the fill, so its
 * background is sized to the track: a fuller bar reveals the warmer end, and
 * using some of the plan takes that colour away with it. An exhausted window
 * keeps no fill; instead the time already waited drifts in as a stripe, so the
 * meter shows the plan coming back rather than only that it ran out.
 */
function UsageMeterFill({
  remainingPercent,
  window,
  fillClassName,
}: {
  readonly remainingPercent: number | null;
  readonly window: SubscriptionUsageWindow;
  readonly fillClassName: string;
}) {
  if (remainingPercent === null) {
    return (
      <span className="block h-full flex-1 rounded-full bg-segment-track" />
    );
  }
  if (remainingPercent <= 0) {
    return (
      <span className="flex h-full flex-1 overflow-hidden rounded-full bg-segment-track">
        <span
          className="block h-full rounded-full bg-usage-meter-recharge bg-size-[8.485px_8.485px] motion-safe:animate-usage-meter-recharge"
          style={{ width: `${String(elapsedWindowPercent(window))}%` }}
        />
      </span>
    );
  }
  return (
    <>
      <span
        className={cn("block h-full rounded-full", fillClassName)}
        style={{
          width: `${String(remainingPercent)}%`,
          backgroundSize: `${String(10_000 / remainingPercent)}% 100%`,
        }}
      />
      {remainingPercent < 100 && (
        <span className="block h-full min-w-1 flex-1 rounded-full bg-segment-track" />
      )}
    </>
  );
}

function elapsedWindowPercent(window: SubscriptionUsageWindow): number {
  const resetAt = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
  if (!window.windowSeconds || Number.isNaN(resetAt)) {
    return 0;
  }
  const left = (resetAt - now()) / (window.windowSeconds * 1000);
  return Math.round(Math.min(1, Math.max(0, 1 - left)) * 100);
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

/**
 * A healthy window carries the brand: amber warming to orange along the track,
 * interpolated in OKLCH so it never passes through grey. Running low switches
 * to the deeper destructive coral and breathes; running out keeps only the
 * destructive number beside the recharge stripe.
 */
function usageTone(remainingPercent: number | null): {
  readonly fillClassName: string;
  readonly textClassName: string;
} {
  if (remainingPercent === null) {
    return { fillClassName: "", textClassName: "text-muted-foreground" };
  }
  if (remainingPercent <= 0) {
    return { fillClassName: "", textClassName: "text-destructive" };
  }
  if (remainingPercent < LOW_REMAINING_PERCENT) {
    return {
      fillClassName:
        remainingPercent <= CRITICAL_REMAINING_PERCENT
          ? "bg-destructive motion-safe:animate-usage-meter-breathe-fast"
          : "bg-destructive motion-safe:animate-usage-meter-breathe",
      textClassName: "text-destructive",
    };
  }
  return {
    fillClassName: "bg-usage-meter-fill",
    textClassName: "text-foreground",
  };
}
