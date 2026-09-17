import { isValidTimeZone, parseScheduledAtTime } from "@okouai/core/timezone";

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
 * The local date is treated as monotonically non-decreasing in absolute time,
 * so the boundary is found by bisection. That is what makes this correct when a
 * spring-forward skips 00:00 entirely: the answer becomes the instant the
 * clock jumps into the day, not a local midnight that never existed.
 *
 * Known limitation: a zone whose local date moves *backwards* breaks that
 * assumption, and bisection then returns the last crossing rather than the
 * first instant of the day. `America/Goose_Bay` turned its clock back at 00:01
 * on 2009-11-01, so this returns `04:00Z` where the day actually begins at
 * `03:00Z`. Such rules are historical rather than current, and the anchor a
 * Morning Brief collects for is the current day, so this is documented instead
 * of widening the repair. No claim is made that every IANA history is exact.
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
 * A provider timestamp that could not be turned into one instant.
 *
 * Every reason is reported as a coverage gap rather than repaired: a guessed
 * instant is indistinguishable from a real meeting once it reaches a brief.
 */
type MorningBriefCalendarTimeFailure =
  /** Not a supported RFC3339 shape, or a component no calendar can hold. */
  | "malformed"
  /** No offset and no usable IANA zone: the instant is simply not stated. */
  | "unknown-timezone"
  /** A wall time a daylight-saving jump skipped over in that zone. */
  | "nonexistent-local-time"
  /** A wall time a daylight-saving repeat makes true twice in that zone. */
  | "ambiguous-local-time";

type MorningBriefCalendarTimeResult =
  | { readonly ok: true; readonly instant: Date }
  | { readonly ok: false; readonly reason: MorningBriefCalendarTimeFailure };

/**
 * Strict RFC3339, which is what Google documents `dateTime` to be.
 *
 * The offset is optional here only so the offsetless-plus-`timeZone` shape can
 * be recognised and resolved explicitly. Anything this does not match is
 * reported as unreadable instead of being handed to `new Date`, whose lenient
 * parsing rolls `2026-02-30` into March and falls back to the machine timezone.
 */
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))?$/u;

interface WallTimeComponents {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/** The civil components as UTC, or `null` when they are not a real moment. */
function civilUtcMs(parts: WallTimeComponents): number | null {
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    return null;
  }
  const utcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  const normalized = new Date(utcMs);
  // Rejects both an impossible day such as 2026-02-30 and the two-digit-year
  // remapping `Date.UTC` applies below 100.
  return normalized.getUTCFullYear() === parts.year &&
    normalized.getUTCMonth() + 1 === parts.month &&
    normalized.getUTCDate() === parts.day
    ? utcMs
    : null;
}

function localDateTimeText(parts: WallTimeComponents): string {
  const pad = (value: number, width = 2): string => {
    return String(value).padStart(width, "0");
  };
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.millisecond, 3)}`;
}

/**
 * The instant a Google event endpoint denotes.
 *
 * An explicit offset identifies the instant on its own and is honoured exactly,
 * so a request from an unfamiliar zone is still readable. Without one, the
 * value is a wall time that only the event's own IANA `timeZone` can place; the
 * repository's scheduling parser resolves it, including the two daylight-saving
 * cases where a wall time names no instant or two. The machine timezone is
 * never consulted, and an unresolvable value never becomes an instant.
 */
export function parseCalendarDateTime(args: {
  readonly value: string;
  readonly timeZone: string | undefined;
}): MorningBriefCalendarTimeResult {
  const match = RFC3339_PATTERN.exec(args.value);
  if (!match) {
    return { ok: false, reason: "malformed" };
  }
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    utcDesignator,
    offsetSign,
    offsetHours,
    offsetMinutes,
  ] = match;
  const parts: WallTimeComponents = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    // Sub-millisecond precision is dropped, never rounded into another second.
    millisecond: Number((fraction ?? "").slice(0, 3).padEnd(3, "0")),
  };
  const utcMs = civilUtcMs(parts);
  if (utcMs === null) {
    return { ok: false, reason: "malformed" };
  }

  if (utcDesignator !== undefined) {
    return { ok: true, instant: new Date(utcMs) };
  }
  if (
    offsetSign !== undefined &&
    offsetHours !== undefined &&
    offsetMinutes !== undefined
  ) {
    const hours = Number(offsetHours);
    const minutes = Number(offsetMinutes);
    if (hours > 23 || minutes > 59) {
      return { ok: false, reason: "malformed" };
    }
    const offsetMs =
      (offsetSign === "-" ? -1 : 1) * (hours * HOUR_MS + minutes * 60 * 1000);
    return { ok: true, instant: new Date(utcMs - offsetMs) };
  }

  if (args.timeZone === undefined || !isValidTimeZone(args.timeZone)) {
    return { ok: false, reason: "unknown-timezone" };
  }
  const zoned = parseScheduledAtTime(localDateTimeText(parts), args.timeZone);
  if (zoned.ok) {
    return { ok: true, instant: zoned.date };
  }
  return {
    ok: false,
    reason:
      zoned.code === "nonexistent-local-time" ||
      zoned.code === "ambiguous-local-time"
        ? zoned.code
        : "malformed",
  };
}

/** Where a provider range sits, or that it is not a usable range at all. */
type MorningBriefCalendarRangePlacement =
  | "in-window"
  | "out-of-window"
  | "invalid-range";

/**
 * Where an all-day event sits against the window's local days.
 *
 * Google renders all-day values as calendar dates with an exclusive end date.
 * They are not instants, so they are compared as dates against the window's
 * local days. Converting them to a fabricated UTC midnight is exactly the bug
 * the sync-token baseline carries.
 *
 * An exclusive end at or before the start covers no day at all. Unlike a timed
 * `start === end`, which Google really does emit as a point in time, such a
 * range has no truthful placement, so it is rejected rather than quietly
 * pinned to its start date.
 */
export function checkAllDayRange(args: {
  readonly start: MorningBriefCalendarDate;
  readonly endExclusive: MorningBriefCalendarDate;
  readonly window: MorningBriefCalendarWindow;
}): MorningBriefCalendarRangePlacement {
  const start = dateKey(args.start);
  const end = dateKey(args.endExclusive);
  if (end <= start) {
    return "invalid-range";
  }
  return start < dateKey(args.window.endDate) &&
    end > dateKey(args.window.startDate)
    ? "in-window"
    : "out-of-window";
}

/**
 * Where a timed event sits against the half-open window.
 *
 * An event ending exactly at the window start, or starting exactly at the
 * window end, is outside it. An event crossing local midnight stays inside.
 * A zero-length event is a real Google shape and keeps its point semantics;
 * an end before its start describes no interval and is rejected.
 */
export function checkTimedRange(args: {
  readonly startAt: Date;
  readonly endAt: Date;
  readonly window: MorningBriefCalendarWindow;
}): MorningBriefCalendarRangePlacement {
  const start = args.startAt.getTime();
  const end = args.endAt.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "invalid-range";
  }
  const windowStart = args.window.startAt.getTime();
  const windowEnd = args.window.endAt.getTime();
  if (end === start) {
    return start >= windowStart && start < windowEnd
      ? "in-window"
      : "out-of-window";
  }
  return start < windowEnd && end > windowStart ? "in-window" : "out-of-window";
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
