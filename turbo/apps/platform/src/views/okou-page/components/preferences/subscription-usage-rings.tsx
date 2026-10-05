import type { ReactNode } from "react";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { subscriptionUsageWindows } from "../../../../lib/subscription-usage-windows.ts";
import { formatSubscriptionUsageReset } from "../../subscription-usage-format.ts";

type SubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
type SubscriptionUsageWindow = NonNullable<SubscriptionUsage["fiveHour"]>;

export function fallbackSubscriptionUsage(
  provider: ModelProviderResponse,
): SubscriptionUsage | null {
  if (subscriptionUsageWindows(provider.subscriptionUsage).length > 0) {
    return provider.subscriptionUsage ?? null;
  }
  const resetAt = provider.subscriptionNextResetAt?.trim();
  if (!resetAt) {
    return null;
  }
  const resetPeriod = provider.subscriptionResetPeriod?.trim().toLowerCase();
  const window = {
    usedPercent: null,
    remainingPercent: null,
    resetAt,
    windowSeconds: resetPeriod?.includes("5") ? 18_000 : 604_800,
  };
  return resetPeriod?.includes("5")
    ? { fiveHour: window, weekly: null }
    : { fiveHour: null, weekly: window };
}

export function formatAccountUsageReset(provider: ModelProviderResponse) {
  const usage = fallbackSubscriptionUsage(provider);
  return formatSubscriptionUsageReset(
    usage?.fiveHour?.resetAt ?? usage?.weekly?.resetAt ?? null,
  );
}

function unknownUsageWindows(): {
  readonly kind: "fiveHour" | "week";
  readonly window: SubscriptionUsageWindow;
}[] {
  return [
    {
      kind: "fiveHour",
      window: {
        usedPercent: null,
        remainingPercent: null,
        resetAt: null,
        windowSeconds: 18_000,
      },
    },
    {
      kind: "week",
      window: {
        usedPercent: null,
        remainingPercent: null,
        resetAt: null,
        windowSeconds: 604_800,
      },
    },
  ];
}

function formatUsagePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function usageTone(remainingPercent: number | null) {
  if (remainingPercent !== null && remainingPercent < 20) {
    return {
      ringClassName: "stroke-red-500",
      ringTrackClassName: "stroke-red-500/15",
      textClassName: "text-red-600 dark:text-red-400",
    };
  }
  if (remainingPercent !== null && remainingPercent < 50) {
    return {
      ringClassName: "stroke-amber-500",
      ringTrackClassName: "stroke-amber-500/15",
      textClassName: "text-amber-600 dark:text-amber-400",
    };
  }
  return {
    ringClassName: "stroke-emerald-500",
    ringTrackClassName: "stroke-emerald-500/15",
    textClassName: "text-emerald-600 dark:text-emerald-400",
  };
}

export function SubscriptionUsageRings({
  className,
  identity,
  usage,
  details,
  showUnknown = false,
}: {
  readonly className?: string;
  readonly showUnknown?: boolean;
  readonly identity: string;
  readonly usage: SubscriptionUsage | null | undefined;
  /** A card can expose full account details in a click/keyboard/touch popover. Settings retains its existing tooltips. */
  readonly details?: ReactNode;
}) {
  const knownWindows = subscriptionUsageWindows(usage);
  const windows =
    showUnknown && knownWindows.length === 0
      ? unknownUsageWindows()
      : knownWindows;
  if (windows.length === 0) {
    return null;
  }
  return (
    <span
      className={cn(
        "ml-auto flex min-w-16 shrink-0 items-center justify-end gap-1.5",
        className,
      )}
    >
      {windows.map(({ kind, window }) => {
        return (
          <SubscriptionUsageRing
            key={kind}
            identity={identity}
            kind={kind}
            window={window}
            details={details}
          />
        );
      })}
    </span>
  );
}

function SubscriptionUsageRing({
  identity,
  kind,
  window,
  details,
}: {
  readonly identity: string;
  readonly kind: "fiveHour" | "week";
  readonly window: SubscriptionUsageWindow;
  readonly details?: ReactNode;
}) {
  const { t } = useTranslation();
  const label =
    kind === "week"
      ? t(($) => {
          return $.settings.models.personal.status.week;
        })
      : t(($) => {
          return $.settings.models.personal.status.fiveHour;
        });
  const shortLabel = kind === "week" ? label.charAt(0) : label;
  const remaining =
    window.remainingPercent ??
    (window.usedPercent === null ? null : 100 - window.usedPercent);
  const tone = usageTone(remaining);
  const ariaLabel = t(
    ($) => {
      return $.settings.accountMenu.subscriptions.usageRemaining;
    },
    { provider: identity, window: label },
  );
  const graphic = (
    <SubscriptionUsageRingGraphic
      shortLabel={shortLabel}
      remaining={remaining}
      tone={tone}
    />
  );
  const content = (
    <SubscriptionUsageWindowDetails
      label={label}
      remaining={remaining}
      window={window}
      tone={tone}
    />
  );
  if (details !== undefined) {
    return (
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="quiet"
              size="icon-2xs"
              aria-label={ariaLabel}
              className="size-7 shrink-0 rounded-full p-0 hover:bg-state-hover [&_svg]:size-7"
            />
          }
        >
          <span
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remaining ?? undefined}
            className="relative flex size-7 items-center justify-center"
          >
            {graphic}
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3"
        >
          {content}
          {details}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remaining ?? undefined}
            className="relative flex h-7 w-7 shrink-0 cursor-default items-center justify-center rounded-full outline-none transition-colors hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            {graphic}
          </span>
        }
      />
      <TooltipContent
        side="bottom"
        sideOffset={8}
        className="min-w-48 border shadow-md bg-popover! text-popover-foreground!"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function SubscriptionUsageRingGraphic({
  shortLabel,
  remaining,
  tone,
}: {
  readonly shortLabel: string;
  readonly remaining: number | null;
  readonly tone: ReturnType<typeof usageTone>;
}) {
  const progress =
    remaining === null ? 0 : Math.min(100, Math.max(0, remaining));
  return (
    <>
      <svg
        aria-hidden="true"
        viewBox="0 0 28 28"
        className="h-7 w-7 -rotate-90"
      >
        <circle
          cx="14"
          cy="14"
          r="11"
          fill="none"
          strokeWidth="3"
          className={tone.ringTrackClassName}
        />
        <circle
          cx="14"
          cy="14"
          r="11"
          fill="none"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - progress}
          strokeLinecap="round"
          strokeWidth="3"
          className={`${tone.ringClassName} transition-[stroke-dashoffset]`}
        />
      </svg>
      <span className="absolute max-w-5 truncate text-[7px] font-semibold leading-none text-muted-foreground">
        {shortLabel}
      </span>
    </>
  );
}

function SubscriptionUsageWindowDetails({
  label,
  remaining,
  window,
  tone,
}: {
  readonly label: string;
  readonly remaining: number | null;
  readonly window: SubscriptionUsageWindow;
  readonly tone: ReturnType<typeof usageTone>;
}) {
  const { t } = useTranslation();
  const displayPercent = formatUsagePercent(remaining);
  const reset = formatSubscriptionUsageReset(window.resetAt);
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium text-foreground">{label}</span>
        <span className={`font-medium ${tone.textClassName}`}>
          {displayPercent
            ? t(
                ($) => {
                  return $.settings.models.personal.status.left;
                },
                { percent: displayPercent },
              )
            : "--"}
        </span>
      </div>
      <SubscriptionUsageResetTooltip reset={reset} />
    </div>
  );
}

function SubscriptionUsageResetTooltip({
  reset,
}: {
  readonly reset: ReturnType<typeof formatSubscriptionUsageReset>;
}) {
  const { t } = useTranslation();
  if (reset === null) {
    return (
      <div className="mt-1 text-[10px] text-muted-foreground">
        {t(($) => {
          return $.settings.accountMenu.subscriptions.resetTimeUnavailable;
        })}
      </div>
    );
  }
  if ("fallbackText" in reset) {
    return (
      <div className="mt-1 text-[10px] text-muted-foreground">
        {reset.fallbackText}
      </div>
    );
  }
  return (
    <div className="mt-1 space-y-0.5">
      <div className="text-xs font-medium text-foreground">
        {reset.tooltipTitle}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {reset.absoluteText}
      </div>
    </div>
  );
}
