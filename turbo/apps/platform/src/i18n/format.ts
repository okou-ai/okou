import { now } from "../lib/time.ts";
import { currentLocale } from "./index.ts";

export function resolvedAppLocale(): string {
  return currentLocale();
}

export function formatAppNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(resolvedAppLocale(), options).format(value);
}

export function formatLocalizedNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return formatAppNumber(value, options);
}

export function formatCompactNumber(
  value: number,
  maximumFractionDigits = 1,
): string {
  return formatLocalizedNumber(value, {
    notation: "compact",
    maximumFractionDigits,
  });
}

export function formatUsd(dollars: number, fractionDigits = 2): string {
  return formatLocalizedNumber(dollars, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** Short date + time used for chat event timestamps. */
export function formatChatTimestamp(value: string): string {
  return new Date(value).toLocaleString(resolvedAppLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Coarse "how long ago" label for list rows, where the exact minute is noise
 * and only the rough age helps the reader rank results. Intl supplies every
 * locale's wording, so this adds no translation keys.
 *
 * Anything a month or older falls through to {@link formatChatTimestamp}: past
 * that point a relative phrase ("2 months ago") is less useful than the date.
 *
 * `value` must parse as a date. Every caller passes a server-issued ISO
 * timestamp, so an unparseable value is a data bug and is left to throw rather
 * than rendered as an empty cell that hides it.
 */
export function formatRelativeTimestamp(value: string): string {
  const elapsedMs = now() - new Date(value).getTime();
  // A timestamp in the future means the client clock trails the server's, which
  // no relative phrase describes usefully; show the absolute date instead.
  if (elapsedMs >= 30 * DAY_MS || elapsedMs < 0) {
    return formatChatTimestamp(value);
  }

  const format = new Intl.RelativeTimeFormat(resolvedAppLocale(), {
    numeric: "auto",
  });
  if (elapsedMs < HOUR_MS) {
    return format.format(-Math.floor(elapsedMs / MINUTE_MS), "minute");
  }
  if (elapsedMs < DAY_MS) {
    return format.format(-Math.floor(elapsedMs / HOUR_MS), "hour");
  }
  if (elapsedMs < WEEK_MS) {
    return format.format(-Math.floor(elapsedMs / DAY_MS), "day");
  }
  return format.format(-Math.floor(elapsedMs / WEEK_MS), "week");
}
