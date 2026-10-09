import { now } from "../../lib/time.ts";
import { i18n } from "../../i18n/index.ts";
import { formatLocalizedNumber, resolvedAppLocale } from "../../i18n/format.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

interface SubscriptionUsageResetFormat {
  readonly absoluteResetText: string;
  readonly absoluteText: string;
  readonly relativeText: string;
  readonly tooltipTitle: string;
}

interface InvalidSubscriptionUsageResetFormat {
  readonly fallbackText: string;
}

type SubscriptionUsageResetDisplay =
  InvalidSubscriptionUsageResetFormat | SubscriptionUsageResetFormat;

export function formatSubscriptionUsageReset(
  resetAt: string | null,
): SubscriptionUsageResetDisplay | null {
  const text = resetAt?.trim();
  if (!text) {
    return null;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return {
      fallbackText: i18n.t(
        ($) => {
          return $.settings.models.usage.resetsRaw;
        },
        { value: text },
      ),
    };
  }

  const absoluteText = formatAbsoluteResetDate(date);
  const relativeText = formatRelativeResetTime(date.getTime() - now());

  return {
    absoluteResetText: i18n.t(
      ($) => {
        return $.settings.models.usage.resetsAt;
      },
      { date: absoluteText },
    ),
    absoluteText,
    relativeText,
    tooltipTitle: formatResetTooltipTitle(relativeText),
  };
}

interface ResetCreditExpiryDisplay {
  readonly relativeText: string;
  readonly absoluteText: string;
}

/**
 * Reset credits are only worth a deadline while they are still redeemable, so
 * an absent, unparseable, or already-passed expiry renders nothing at all
 * rather than a stale "expired" label next to a positive credit count.
 */
export function formatCodexResetCreditExpiry(
  expiresAt: string | null | undefined,
): ResetCreditExpiryDisplay | null {
  const text = expiresAt?.trim();
  if (!text) {
    return null;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const remainingMs = date.getTime() - now();
  if (remainingMs <= 0) {
    return null;
  }

  return {
    relativeText: formatRelativeResetTime(remainingMs),
    absoluteText: formatAbsoluteResetDate(date),
  };
}

function formatAbsoluteResetDate(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  const browserTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (browserTimeZone) {
    options.timeZone = browserTimeZone;
  }
  return date.toLocaleDateString(resolvedAppLocale(), options);
}

function resetTimePassed(): string {
  return i18n.t(($) => {
    return $.settings.models.usage.resetTimePassed;
  });
}

function formatResetTooltipTitle(relativeText: string): string {
  if (relativeText === resetTimePassed()) {
    return i18n.t(($) => {
      return $.settings.models.usage.resetTimePassedTitle;
    });
  }
  return i18n.t(
    ($) => {
      return $.settings.models.usage.resetsRelative;
    },
    { relative: relativeText },
  );
}

function formatRelativeResetTime(remainingMs: number): string {
  if (remainingMs <= 0) {
    return resetTimePassed();
  }
  if (remainingMs < MINUTE_MS) {
    return i18n.t(($) => {
      return $.settings.models.usage.inLessThanMinute;
    });
  }

  const totalMinutes = Math.floor(remainingMs / MINUTE_MS);
  if (remainingMs < HOUR_MS) {
    return i18n.t(
      ($) => {
        return $.settings.models.usage.inMinutes;
      },
      { minutes: formatLocalizedNumber(totalMinutes) },
    );
  }

  const totalHours = Math.floor(remainingMs / HOUR_MS);
  if (remainingMs < DAY_MS) {
    const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
    if (minutes > 0) {
      return i18n.t(
        ($) => {
          return $.settings.models.usage.inHoursMinutes;
        },
        {
          hours: formatLocalizedNumber(totalHours),
          minutes: formatLocalizedNumber(minutes),
        },
      );
    }
    return i18n.t(
      ($) => {
        return $.settings.models.usage.inHours;
      },
      { hours: formatLocalizedNumber(totalHours) },
    );
  }

  const totalDays = Math.floor(remainingMs / DAY_MS);
  if (remainingMs < WEEK_MS) {
    const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
    if (hours > 0) {
      return i18n.t(
        ($) => {
          return $.settings.models.usage.inDaysHours;
        },
        {
          days: formatLocalizedNumber(totalDays),
          hours: formatLocalizedNumber(hours),
        },
      );
    }
  }

  return i18n.t(
    ($) => {
      return $.settings.models.usage.inDays;
    },
    { days: formatLocalizedNumber(totalDays) },
  );
}
