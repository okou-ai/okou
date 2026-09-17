import { isValidTimeZone } from "@okouai/core/timezone";

/**
 * The reporting window a Morning Brief calendar read covers.
 *
 * Morning Brief promises "today plus the near term" in the recipient's own
 * timezone, so the window is calendar arithmetic over local days rather than a
 * fixed number of hours. Three local days across a daylight-saving boundary are
 * 71 or 73 hours, and the existing webhook sync baseline
 * (`google-calendar-automation-event.service.ts`) cannot supply this: it is an
 * unbounded sync-token reader whose date parser appends UTC midnight to
 * date-only values, which misplaces every all-day event outside UTC.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Local midnight never moves further than this from its UTC civil instant. */
const SEARCH_MARGIN_MS = 18 * HOUR_MS;

/** Days covered: day 0 is today, days 1 and 2 are the near term. */
const MORNING_BRIEF_CALENDAR_WINDOW_DAYS = 3;

/** A calendar date in the owner's timezone, as Google renders date-only values. */
export interface MorningBriefCalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface MorningBriefCalendarWindow {
  readonly timezone: string;
  /** Inclusive start: the first instant of the local day containing the anchor. */
  readonly startAt: Date;
  /** Exclusive end: the first instant of the local day `days` later. */
  readonly endAt: Date;
  /** The local day containing the anchor. */
  readonly startDate: MorningBriefCalendarDate;
  /** The first local day outside the window, matching the exclusive `endAt`. */
  readonly endDate: MorningBriefCalendarDate;
  /** Every covered local day, oldest first. */
  readonly localDays: readonly MorningBriefCalendarDate[];
}

type MorningBriefCalendarWindowResult =
  | { readonly ok: true; readonly window: MorningBriefCalendarWindow }
  | {
      readonly ok: false;
      readonly code: "invalid-timezone" | "invalid-anchor";
    };

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
}

function partValue(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  return Number(
    parts.find((part) => {
      return part.type === type;
    })?.value ?? "0",
  );
}

/** The local calendar date at an instant, as a comparable `YYYYMMDD` number. */
function localDateKeyAt(formatter: Intl.DateTimeFormat, instantMs: number) {
  const parts = formatter.formatToParts(new Date(instantMs));
  const year = partValue(parts, "year");
  const month = partValue(parts, "month");
  const day = partValue(parts, "day");
  return { year, month, day, key: year * 10_000 + month * 100 + day };
}

function dateKey(date: MorningBriefCalendarDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}

function addDays(
  date: MorningBriefCalendarDate,
  days: number,
): MorningBriefCalendarDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The first instant belonging to a local day.
 *
 * The local date is monotonically non-decreasing in absolute time, so the
 * boundary is found by bisection. That is what makes this correct when a
 * spring-forward skips 00:00 entirely: the answer becomes the instant the
 * clock jumps into the day, not a local midnight that never existed.
 */
function startOfLocalDay(
  formatter: Intl.DateTimeFormat,
  date: MorningBriefCalendarDate,
): Date {
  const target = dateKey(date);
  const civilMs = Date.UTC(date.year, date.month - 1, date.day);
  let low = civilMs - SEARCH_MARGIN_MS;
  let high = civilMs + SEARCH_MARGIN_MS;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateKeyAt(formatter, middle).key >= target) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return new Date(low);
}

/**
 * Freezes the collection window from a validated anchor.
 *
 * The anchor is the only caller-supplied input the preview route accepts, and
 * the timezone comes from the owner's canonical Morning Brief state, never from
 * the request.
 */
export function resolveMorningBriefCalendarWindow(args: {
  readonly anchor: Date;
  readonly timezone: string;
  readonly days?: number;
}): MorningBriefCalendarWindowResult {
  const anchorMs = args.anchor.getTime();
  if (!Number.isFinite(anchorMs)) {
    return { ok: false, code: "invalid-anchor" };
  }
  if (!isValidTimeZone(args.timezone)) {
    return { ok: false, code: "invalid-timezone" };
  }

  const days = args.days ?? MORNING_BRIEF_CALENDAR_WINDOW_DAYS;
  const formatter = partsFormatter(args.timezone);
  const anchorDate = localDateKeyAt(formatter, anchorMs);
  const startDate: MorningBriefCalendarDate = {
    year: anchorDate.year,
    month: anchorDate.month,
    day: anchorDate.day,
  };
  const endDate = addDays(startDate, days);
  const localDays = Array.from({ length: days }, (_, offset) => {
    return addDays(startDate, offset);
  });

  return {
    ok: true,
    window: {
      timezone: args.timezone,
      startAt: startOfLocalDay(formatter, startDate),
      endAt: startOfLocalDay(formatter, endDate),
      startDate,
      endDate,
      localDays,
    },
  };
}

export function formatCalendarDate(date: MorningBriefCalendarDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function parseCalendarDate(
  value: string,
): MorningBriefCalendarDate | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const parsed = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
  };
  const normalized = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day),
  );
  if (
    normalized.getUTCFullYear() !== parsed.year ||
    normalized.getUTCMonth() + 1 !== parsed.month ||
    normalized.getUTCDate() !== parsed.day
  ) {
    return null;
  }
  return parsed;
}

/**
 * Whether an all-day event overlaps the window's local days.
 *
 * Google renders all-day values as calendar dates with an exclusive end date.
 * They are not instants, so they are compared as dates against the window's
 * local days. Converting them to a fabricated UTC midnight is exactly the bug
 * the sync-token baseline carries.
 */
export function allDayRangeOverlapsWindow(args: {
  readonly start: MorningBriefCalendarDate;
  readonly endExclusive: MorningBriefCalendarDate;
  readonly window: MorningBriefCalendarWindow;
}): boolean {
  const start = dateKey(args.start);
  const end = dateKey(args.endExclusive);
  if (end <= start) {
    // A malformed or single-instant range still occupies its start date.
    return (
      start >= dateKey(args.window.startDate) &&
      start < dateKey(args.window.endDate)
    );
  }
  return (
    start < dateKey(args.window.endDate) && end > dateKey(args.window.startDate)
  );
}

/**
 * Whether a timed event overlaps the half-open window.
 *
 * An event ending exactly at the window start, or starting exactly at the
 * window end, is outside it. An event crossing local midnight stays inside.
 */
export function timedRangeOverlapsWindow(args: {
  readonly startAt: Date;
  readonly endAt: Date;
  readonly window: MorningBriefCalendarWindow;
}): boolean {
  const start = args.startAt.getTime();
  const end = args.endAt.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return false;
  }
  const windowStart = args.window.startAt.getTime();
  const windowEnd = args.window.endAt.getTime();
  if (end <= start) {
    // Zero-length events are a real Google shape; treat them as a point.
    return start >= windowStart && start < windowEnd;
  }
  return start < windowEnd && end > windowStart;
}

/** The covered local day an item is grouped under, or `null` when outside. */
export function localDayOffsetOf(
  window: MorningBriefCalendarWindow,
  date: MorningBriefCalendarDate,
): number | null {
  const offset = window.localDays.findIndex((day) => {
    return dateKey(day) === dateKey(date);
  });
  return offset === -1 ? null : offset;
}
