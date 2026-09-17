import {
  allDayRangeOverlapsWindow,
  formatCalendarDate,
  parseCalendarDate,
  resolveMorningBriefCalendarWindow,
  timedRangeOverlapsWindow,
  type MorningBriefCalendarWindow,
} from "../morning-brief-calendar-window";

function windowFor(
  anchor: string,
  timezone: string,
): MorningBriefCalendarWindow {
  const result = resolveMorningBriefCalendarWindow({
    anchor: new Date(anchor),
    timezone,
  });
  if (!result.ok) {
    throw new Error(`expected a window, got ${result.code}`);
  }
  return result.window;
}

describe("morning brief calendar window", () => {
  it("starts at the owner's local midnight containing the anchor", () => {
    const window = windowFor("2026-03-10T02:30:00.000Z", "Asia/Shanghai");

    // 2026-03-10T02:30Z is 10:30 on 2026-03-10 in +08:00.
    expect(formatCalendarDate(window.startDate)).toBe("2026-03-10");
    expect(window.startAt.toISOString()).toBe("2026-03-09T16:00:00.000Z");
    expect(formatCalendarDate(window.endDate)).toBe("2026-03-13");
    expect(window.endAt.toISOString()).toBe("2026-03-12T16:00:00.000Z");
  });

  it("covers three calendar days, not 72 hours, across a spring-forward", () => {
    // America/Los_Angeles moves to DST on 2026-03-08.
    const window = windowFor("2026-03-07T20:00:00.000Z", "America/Los_Angeles");

    expect(formatCalendarDate(window.startDate)).toBe("2026-03-07");
    expect(window.localDays.map(formatCalendarDate)).toStrictEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
    const hours =
      (window.endAt.getTime() - window.startAt.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(71);
  });

  it("covers 73 hours across a fall-back", () => {
    // America/Los_Angeles leaves DST on 2026-11-01.
    const window = windowFor("2026-10-31T18:00:00.000Z", "America/Los_Angeles");

    expect(formatCalendarDate(window.startDate)).toBe("2026-10-31");
    const hours =
      (window.endAt.getTime() - window.startAt.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(73);
  });

  it("starts at the first existing instant when local midnight is skipped", () => {
    // America/Santiago springs forward at 00:00 on 2026-09-06, so that day
    // has no 00:00 at all.
    const window = windowFor("2026-09-06T15:00:00.000Z", "America/Santiago");

    expect(formatCalendarDate(window.startDate)).toBe("2026-09-06");
    expect(window.startAt.toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  it("rejects an unusable timezone or anchor instead of guessing", () => {
    expect(
      resolveMorningBriefCalendarWindow({
        anchor: new Date("2026-03-10T00:00:00.000Z"),
        timezone: "Mars/Olympus",
      }),
    ).toStrictEqual({ ok: false, code: "invalid-timezone" });
    expect(
      resolveMorningBriefCalendarWindow({
        anchor: new Date("not-a-date"),
        timezone: "UTC",
      }),
    ).toStrictEqual({ ok: false, code: "invalid-anchor" });
  });

  describe("timed overlap", () => {
    const window = windowFor("2026-03-10T02:30:00.000Z", "Asia/Shanghai");

    it("excludes an event ending exactly at the window start", () => {
      expect(
        timedRangeOverlapsWindow({
          startAt: new Date("2026-03-09T15:00:00.000Z"),
          endAt: window.startAt,
          window,
        }),
      ).toBeFalsy();
    });

    it("excludes an event starting exactly at the window end", () => {
      expect(
        timedRangeOverlapsWindow({
          startAt: window.endAt,
          endAt: new Date("2026-03-12T17:00:00.000Z"),
          window,
        }),
      ).toBeFalsy();
    });

    it("keeps an event that crosses into the window", () => {
      expect(
        timedRangeOverlapsWindow({
          startAt: new Date("2026-03-09T15:30:00.000Z"),
          endAt: new Date("2026-03-09T16:30:00.000Z"),
          window,
        }),
      ).toBeTruthy();
    });

    it("keeps a zero-length event inside the window", () => {
      expect(
        timedRangeOverlapsWindow({
          startAt: window.startAt,
          endAt: window.startAt,
          window,
        }),
      ).toBeTruthy();
    });
  });

  describe("all-day overlap", () => {
    const window = windowFor("2026-03-10T02:30:00.000Z", "Asia/Shanghai");

    it("treats the end date as exclusive", () => {
      expect(
        allDayRangeOverlapsWindow({
          start: parseCalendarDate("2026-03-09")!,
          endExclusive: parseCalendarDate("2026-03-10")!,
          window,
        }),
      ).toBeFalsy();
      expect(
        allDayRangeOverlapsWindow({
          start: parseCalendarDate("2026-03-12")!,
          endExclusive: parseCalendarDate("2026-03-13")!,
          window,
        }),
      ).toBeTruthy();
      expect(
        allDayRangeOverlapsWindow({
          start: parseCalendarDate("2026-03-13")!,
          endExclusive: parseCalendarDate("2026-03-14")!,
          window,
        }),
      ).toBeFalsy();
    });

    it("keeps a multi-day range that spans the window", () => {
      expect(
        allDayRangeOverlapsWindow({
          start: parseCalendarDate("2026-03-01")!,
          endExclusive: parseCalendarDate("2026-04-01")!,
          window,
        }),
      ).toBeTruthy();
    });

    it("rejects a malformed date rather than shifting it to UTC midnight", () => {
      expect(parseCalendarDate("2026-02-30")).toBeNull();
      expect(parseCalendarDate("2026-3-9")).toBeNull();
      expect(parseCalendarDate("2026-03-09T00:00:00Z")).toBeNull();
    });
  });
});
