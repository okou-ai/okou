export const DEFAULT_USER_TIMEZONE = "America/Los_Angeles";

/**
 * Returns the GMT offset string for an IANA timezone at the current instant
 * (e.g. "GMT+05:30"). Called at render time so DST transitions are reflected
 * correctly without stale cached values.
 */
export function getGmtOffset(iana: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: iana,
    timeZoneName: "longOffset",
  }).formatToParts(new Date());
  return (
    parts.find((p) => {
      return p.type === "timeZoneName";
    })?.value ?? "GMT+00:00"
  );
}

const EXPLICIT_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/u;
const LOCAL_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type ScheduledAtTimeParseErrorCode =
  | "invalid-at-time"
  | "invalid-timezone"
  | "nonexistent-local-time"
  | "ambiguous-local-time";

export type ScheduledAtTimeParseResult =
  | {
      readonly ok: true;
      readonly date: Date;
      readonly hasExplicitOffset: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ScheduledAtTimeParseErrorCode;
      readonly message: string;
    };

interface WallTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

export function hasExplicitDateTimeOffset(input: string): boolean {
  return EXPLICIT_OFFSET_RE.test(input.trim());
}

export function isValidTimeZone(input: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: input });
    return true;
  } catch {
    return false;
  }
}

function datePart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return (
    parts.find((part) => {
      return part.type === type;
    })?.value ?? "0"
  );
}

function wallTimePartsInTimezone(
  timezone: string,
  instantMs: number,
): WallTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).formatToParts(new Date(instantMs));
  return {
    year: Number(datePart(parts, "year")),
    month: Number(datePart(parts, "month")),
    day: Number(datePart(parts, "day")),
    hour: Number(datePart(parts, "hour")),
    minute: Number(datePart(parts, "minute")),
    second: Number(datePart(parts, "second")),
    millisecond: new Date(instantMs).getUTCMilliseconds(),
  };
}

function timezoneOffsetMinutes(timezone: string, instantMs: number): number {
  const parts = wallTimePartsInTimezone(timezone, instantMs);
  const wallTimeAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return (wallTimeAsUtc - instantMs) / MINUTE_MS;
}

function parseLocalDateTime(input: string): WallTimeParts | null {
  const match = LOCAL_DATE_TIME_RE.exec(input.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, millisecond] = match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return null;
  }
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: second === undefined ? 0 : Number(second),
    millisecond:
      millisecond === undefined ? 0 : Number(millisecond.padEnd(3, "0")),
  };
  const normalized = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    ),
  );
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute ||
    normalized.getUTCSeconds() !== parts.second ||
    normalized.getUTCMilliseconds() !== parts.millisecond
  ) {
    return null;
  }
  return parts;
}

function wallTimeMatches(
  timezone: string,
  instantMs: number,
  expected: WallTimeParts,
): boolean {
  const actual = wallTimePartsInTimezone(timezone, instantMs);
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute &&
    actual.second === expected.second &&
    actual.millisecond === expected.millisecond
  );
}

function zonedWallTimeCandidates(
  timezone: string,
  wallTime: WallTimeParts,
): readonly Date[] {
  const wallTimeAsUtc = Date.UTC(
    wallTime.year,
    wallTime.month - 1,
    wallTime.day,
    wallTime.hour,
    wallTime.minute,
    wallTime.second,
    wallTime.millisecond,
  );
  const offsets = new Set<number>();
  for (const hourDelta of [-48, -36, -24, -12, -6, 0, 6, 12, 24, 36, 48]) {
    offsets.add(
      timezoneOffsetMinutes(timezone, wallTimeAsUtc + hourDelta * HOUR_MS),
    );
  }
  const candidateTimes = new Set<number>();
  for (const offset of offsets) {
    const candidateMs = wallTimeAsUtc - offset * MINUTE_MS;
    if (wallTimeMatches(timezone, candidateMs, wallTime)) {
      candidateTimes.add(candidateMs);
    }
  }
  return [...candidateTimes]
    .sort((a, b) => {
      return a - b;
    })
    .map((ms) => {
      return new Date(ms);
    });
}

export function parseScheduledAtTime(
  input: string,
  timezone: string,
): ScheduledAtTimeParseResult {
  const value = input.trim();
  if (!isValidTimeZone(timezone)) {
    return {
      ok: false,
      code: "invalid-timezone",
      message: `Invalid timezone: ${timezone}`,
    };
  }
  if (hasExplicitDateTimeOffset(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return {
        ok: false,
        code: "invalid-at-time",
        message: `Invalid atTime: ${input}`,
      };
    }
    return { ok: true, date, hasExplicitOffset: true };
  }

  const wallTime = parseLocalDateTime(value);
  if (wallTime === null) {
    return {
      ok: false,
      code: "invalid-at-time",
      message:
        "Invalid atTime: use an ISO datetime with Z/offset, or pass a local ISO datetime with timezone",
    };
  }

  const candidates = zonedWallTimeCandidates(timezone, wallTime);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "nonexistent-local-time",
      message: `Invalid atTime: ${input} does not exist in ${timezone}`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: "ambiguous-local-time",
      message: `Invalid atTime: ${input} is ambiguous in ${timezone}; include Z or an explicit offset`,
    };
  }
  return { ok: true, date: candidates[0]!, hasExplicitOffset: false };
}
