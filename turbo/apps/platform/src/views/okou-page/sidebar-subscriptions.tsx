import { useGet, useLoadable } from "ccstate-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import {
  ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS,
  accountMenuSubscriptionUsageRowsRefreshPromise$,
  accountMenuSubscriptionUsageRowsCache$,
  type AccountMenuSubscriptionUsage,
  type AccountMenuSubscriptionUsageRow,
  type AccountMenuSubscriptionUsageWindow,
  type AccountMenuSubscriptionUsageRowsCacheKey,
} from "../../signals/okou-page/account-menu-subscriptions.ts";
import { limitingSubscriptionUsageWindow } from "../../lib/subscription-usage-windows.ts";
import { now } from "../../lib/time.ts";
import {
  CodexResetCreditsButton,
  CodexResetCreditsMenuItem,
} from "./components/preferences/codex-reset-usage-dialog.tsx";
import { formatSubscriptionUsageReset } from "./subscription-usage-format.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";

type SubscriptionUsage = AccountMenuSubscriptionUsage;
type SubscriptionUsageWindow = AccountMenuSubscriptionUsageWindow;

/** Below this much left, a window turns amber, breathes and shows its reset. */
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
  const { t } = useTranslation();
  return (
    <div
      data-testid="account-menu-subscriptions"
      className="px-3 pt-1.5 pb-2.5"
    >
      {loading && rows.length === 0 ? (
        <AccountMenuSubscriptionsSkeleton />
      ) : (
        <TooltipProvider delay={100}>
          <div className="flex flex-col gap-3">
            {rows.map((row) => {
              const label =
                row.type === "codex-oauth-token"
                  ? t(($) => {
                      return $.settings.models.personal.codexGroup;
                    })
                  : t(($) => {
                      return $.settings.models.personal.claudeGroup;
                    });
              return (
                <AccountMenuSubscriptionProviderSection
                  key={row.type}
                  type={row.type}
                  label={label}
                  usage={row.usage}
                  resetCredits={row.resetCredits}
                  resetCreditsNextExpiresAt={row.resetCreditsNextExpiresAt}
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
    <div className="flex flex-col gap-3" aria-hidden="true">
      {ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS.map((provider) => {
        return (
          <div key={provider.type} className="flex flex-col gap-1.5">
            <div className="flex h-5 items-center">
              <div className="h-3 w-28 animate-skeleton-pulse rounded bg-skeleton" />
            </div>
            <div className="flex h-4 items-center gap-2">
              <div className="h-3 w-8 animate-skeleton-pulse rounded bg-skeleton" />
              <div className="h-1 flex-1 animate-skeleton-pulse rounded-full bg-skeleton" />
              <div className="h-3 w-8 animate-skeleton-pulse rounded bg-skeleton" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One plan: its name with the Codex reset control top right, then the window
 * that limits it right now. Every line is 12px; weight and colour carry the
 * hierarchy, so the panel reads as one block inside the 14px menu.
 */
function AccountMenuSubscriptionProviderSection({
  type,
  label,
  usage,
  resetCredits,
  resetCreditsNextExpiresAt,
  resetPending,
  resetControl,
  onResetCodexUsage,
}: {
  readonly type: AccountMenuSubscriptionUsageRow["type"];
  readonly label: string;
  readonly usage: SubscriptionUsage;
  readonly resetCredits?: number | null;
  readonly resetCreditsNextExpiresAt?: string | null;
  readonly resetPending: boolean;
  readonly resetControl: "menu" | "button";
  readonly onResetCodexUsage?: (resetCredits: number | null) => void;
}) {
  const { t } = useTranslation();
  const limiting = limitingSubscriptionUsageWindow(usage);
  const remaining = limiting?.remainingPercent ?? null;
  const low = remaining !== null && remaining < LOW_REMAINING_PERCENT;
  const reset =
    low && limiting !== null
      ? formatSubscriptionUsageReset(limiting.window.resetAt)
      : null;

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
      <div className="flex min-h-5 min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-xs leading-5 text-muted-foreground">
          {label}
        </h3>
        {type !== "codex-oauth-token" || resetCredits === undefined ? null : (
          <AccountMenuCodexResetControl
            resetControl={resetControl}
            emphasized={low}
            resetCredits={resetCredits}
            resetCreditsNextExpiresAt={resetCreditsNextExpiresAt}
            resetPending={resetPending}
            onResetCodexUsage={onResetCodexUsage}
          />
        )}
      </div>
      {limiting === null ? null : (
        <AccountMenuSubscriptionUsageBar
          providerLabel={label}
          windowLabel={
            limiting.kind === "fiveHour"
              ? t(($) => {
                  return $.settings.models.personal.status.fiveHour;
                })
              : t(($) => {
                  return $.settings.models.personal.status.week;
                })
          }
          window={limiting.window}
          remainingPercent={limiting.remainingPercent}
        />
      )}
      {reset === null ? null : (
        <p className="pl-10 text-xs leading-4 tabular-nums text-muted-foreground">
          {"fallbackText" in reset ? reset.fallbackText : reset.tooltipTitle}
        </p>
      )}
    </section>
  );
}

/** Muted at rest; it turns foreground once the plan runs low, when it matters. */
function AccountMenuCodexResetControl({
  resetControl,
  emphasized,
  resetCredits,
  resetCreditsNextExpiresAt,
  resetPending,
  onResetCodexUsage,
}: {
  readonly resetControl: "menu" | "button";
  readonly emphasized: boolean;
  readonly resetCredits: number | null;
  readonly resetCreditsNextExpiresAt?: string | null;
  readonly resetPending: boolean;
  readonly onResetCodexUsage?: (resetCredits: number | null) => void;
}) {
  const onReset = onResetCodexUsage
    ? () => {
        onResetCodexUsage(resetCredits);
      }
    : undefined;
  if (resetControl === "menu") {
    return (
      <CodexResetCreditsMenuItem
        className={cn(
          "-my-1 -me-1 ml-auto min-h-7 text-xs",
          emphasized && "text-foreground",
        )}
        resetCredits={resetCredits}
        resetCreditsNextExpiresAt={resetCreditsNextExpiresAt}
        resetPending={resetPending}
        onReset={onReset}
      />
    );
  }
  return (
    <CodexResetCreditsButton
      className={cn(
        "-my-1 -me-1 ml-auto",
        emphasized ? "text-foreground" : "text-muted-foreground",
      )}
      resetCredits={resetCredits}
      resetCreditsNextExpiresAt={resetCreditsNextExpiresAt}
      resetPending={resetPending}
      onReset={onReset}
    />
  );
}

function AccountMenuSubscriptionUsageBar({
  providerLabel,
  windowLabel,
  window,
  remainingPercent,
}: {
  readonly providerLabel: string;
  readonly windowLabel: string;
  readonly window: SubscriptionUsageWindow;
  readonly remainingPercent: number | null;
}) {
  const { t } = useTranslation();
  const displayPercent = formatUsagePercent(remainingPercent);
  const reset = formatSubscriptionUsageReset(window.resetAt);
  const tone = usageTone(remainingPercent);

  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 truncate text-xs leading-4 text-muted-foreground">
        {windowLabel}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
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
              className="flex h-1 min-w-0 flex-1 gap-0.5 rounded-full outline-none ring-offset-1 ring-offset-popover transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
            >
              <UsageMeterFill
                remainingPercent={remainingPercent}
                window={window}
                fillClassName={tone.fillClassName}
              />
            </span>
          }
        />
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
              <p className="text-[10px] text-on-filled/60">
                {reset.absoluteText}
              </p>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      <span
        className={`w-8 shrink-0 text-right text-xs font-medium leading-4 tabular-nums ${tone.textClassName}`}
      >
        {displayPercent ?? "--"}
      </span>
    </div>
  );
}

/**
 * The fill and what is left are two pieces with a 2px gap between them. An
 * exhausted window keeps no fill; instead the time already waited drifts in as
 * a stripe, so the meter shows the plan coming back rather than only that it
 * ran out.
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
        style={{ width: `${String(remainingPercent)}%` }}
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
 * A healthy window recedes in the neutral ramp; colour is reserved for the two
 * moments that ask the user to act: running low, and running out.
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
          ? "bg-primary motion-safe:animate-usage-meter-breathe-fast"
          : "bg-primary motion-safe:animate-usage-meter-breathe",
      textClassName: "text-brand-text",
    };
  }
  return { fillClassName: "bg-gray-800", textClassName: "text-foreground" };
}
