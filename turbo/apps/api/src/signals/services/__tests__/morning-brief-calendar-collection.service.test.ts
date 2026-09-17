import { describe, expect, it } from "vitest";

import {
  collectCalendarsWithReader,
  MORNING_BRIEF_CALENDAR_CAPS,
} from "../morning-brief-calendar-collection.service";
import type {
  MorningBriefConnectorReader,
  MorningBriefReadOutcome,
} from "../morning-brief-connector-reader.service";
import {
  resolveMorningBriefCalendarWindow,
  type MorningBriefCalendarWindow,
} from "../morning-brief-calendar-window";

/**
 * Google Calendar semantics, driven through the shared reader's outcome
 * contract.
 *
 * These cases deliberately do not assert the authorization decision: that
 * boundary belongs to the shared reader and is proved against its real
 * implementation in the preview route suite, not against a stand-in here that
 * could be made to allow everything.
 */

const ANCHOR = new Date("2026-03-10T02:30:00.000Z");
const TIMEZONE = "Asia/Shanghai";

function windowFor(timezone = TIMEZONE): MorningBriefCalendarWindow {
  const result = resolveMorningBriefCalendarWindow({
    anchor: ANCHOR,
    timezone,
  });
  if (!result.ok) {
    throw new Error(result.code);
  }
  return result.window;
}

interface ScriptedCall {
  readonly pathname: string;
  readonly query: Readonly<Record<string, string>>;
}

type ScriptedOutcome =
  | { readonly kind: "ok"; readonly value: unknown }
  | Exclude<MorningBriefReadOutcome<never>, { kind: "ok" }>;

function ok(value: unknown): ScriptedOutcome {
  return { kind: "ok", value };
}

function calendarList(
  items: readonly Record<string, unknown>[],
  nextPageToken?: string,
): ScriptedOutcome {
  return ok({
    items,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
}

function eventsPage(
  items: readonly Record<string, unknown>[],
  nextPageToken?: string,
): ScriptedOutcome {
  return ok({
    items,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
}

/** A reader double whose responses are scripted per request, in arrival order. */
function scriptedReader(
  respond: (call: ScriptedCall, index: number) => ScriptedOutcome,
): {
  readonly reader: MorningBriefConnectorReader;
  readonly calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  const reader: MorningBriefConnectorReader = {
    accountEmail: "owner@example.test",
    getJson({ pathname, query, schema }) {
      const call = { pathname, query: query ?? {} };
      const index = calls.length;
      calls.push(call);
      const outcome = respond(call, index);
      if (outcome.kind !== "ok") {
        return Promise.resolve(outcome);
      }
      const parsed = schema.safeParse(outcome.value);
      return Promise.resolve(
        parsed.success
          ? { kind: "ok", value: parsed.data }
          : { kind: "malformed" },
      );
    },
  };
  return { reader, calls };
}

function collect(
  reader: MorningBriefConnectorReader,
  window: MorningBriefCalendarWindow = windowFor(),
) {
  return collectCalendarsWithReader({ reader, window });
}

function isCalendarList(call: ScriptedCall): boolean {
  return call.pathname === "users/me/calendarList";
}

const PRIMARY = {
  id: "owner@example.com",
  summary: "Owner",
  accessRole: "owner",
  primary: true,
  timeZone: "Asia/Shanghai",
};
const SHARED = {
  id: "team@example.com",
  summary: "Team",
  accessRole: "reader",
  timeZone: "America/Los_Angeles",
};
const FREE_BUSY = {
  id: "exec@example.com",
  summary: "Exec",
  accessRole: "freeBusyReader",
};

function timedEvent(overrides: Record<string, unknown>) {
  return {
    id: "event-1",
    status: "confirmed",
    summary: "Standup",
    start: { dateTime: "2026-03-10T01:00:00.000Z" },
    end: { dateTime: "2026-03-10T01:30:00.000Z" },
    htmlLink: "https://calendar.google.com/event?eid=abc",
    ...overrides,
  };
}

describe("morning brief calendar collection", () => {
  it("reads every readable calendar and represents free/busy as a limit", async () => {
    const { reader, calls } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY, SHARED, FREE_BUSY])
        : eventsPage([timedEvent({ id: `e-${call.pathname}` })]);
    });

    const result = await collect(reader);

    expect(result.items).toHaveLength(2);
    expect(
      result.state.coverage.find((entry) => {
        return entry.calendarId === FREE_BUSY.id;
      })?.outcome,
    ).toBe("free-busy-only");
    // No request was made against the free/busy-only calendar.
    expect(
      calls.some((call) => {
        return call.pathname.includes(encodeURIComponent(FREE_BUSY.id));
      }),
    ).toBeFalsy();
  });

  it("asks the provider for the frozen window with single instances", async () => {
    const window = windowFor();
    const { reader, calls } = scriptedReader((call) => {
      return isCalendarList(call) ? calendarList([PRIMARY]) : eventsPage([]);
    });

    await collect(reader, window);

    expect(calls[0]?.query["showDeleted"]).toBe("false");
    expect(calls[1]?.query).toMatchObject({
      timeMin: window.startAt.toISOString(),
      timeMax: window.endAt.toISOString(),
      singleEvents: "true",
      showDeleted: "false",
      orderBy: "startTime",
    });
  });

  it("never falls back to primary when the calendar list is denied", async () => {
    const { reader, calls } = scriptedReader(() => {
      return { kind: "denied" };
    });

    const result = await collect(reader);

    expect(result.listCoverage).toBe("denied");
    expect(result.items).toStrictEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("keeps a healthy sibling when one calendar is denied", async () => {
    const { reader } = scriptedReader((call) => {
      if (isCalendarList(call)) {
        return calendarList([PRIMARY, SHARED]);
      }
      return call.pathname.includes(encodeURIComponent(SHARED.id))
        ? { kind: "denied" }
        : eventsPage([timedEvent({})]);
    });

    const result = await collect(reader);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.calendarId).toBe(PRIMARY.id);
    expect(
      result.state.coverage.find((entry) => {
        return entry.calendarId === SHARED.id;
      })?.outcome,
    ).toBe("denied");
  });

  it("stops requesting calendars once the source is revoked", async () => {
    const { reader, calls } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY, SHARED])
        : { kind: "revoked" };
    });

    const result = await collect(reader);

    expect(result.state.revoked).toBeTruthy();
    // The list plus at most the concurrent in-flight reads; never a new one.
    expect(calls.length).toBeLessThanOrEqual(
      1 + MORNING_BRIEF_CALENDAR_CAPS.concurrency,
    );
  });

  it("reports an empty page with a continuation token as truncated", async () => {
    const { reader } = scriptedReader((call, index) => {
      if (isCalendarList(call)) {
        return calendarList([PRIMARY]);
      }
      return index === 1
        ? eventsPage([], "next")
        : eventsPage([], "still-more");
    });

    const result = await collect(reader);

    expect(result.items).toStrictEqual([]);
    expect(result.state.coverage[0]?.outcome).toBe("truncated");
    expect([...result.state.truncations]).toContain("event-pages");
  });

  it("reports a genuine empty read as complete", async () => {
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call) ? calendarList([PRIMARY]) : eventsPage([]);
    });

    const result = await collect(reader);

    expect(result.items).toStrictEqual([]);
    expect(result.listCoverage).toBe("complete");
    expect(result.state.coverage[0]?.outcome).toBe("complete");
    expect([...result.state.truncations]).toStrictEqual([]);
  });

  it("keeps recurrence identity and drops cancelled instances", async () => {
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY])
        : eventsPage([
            timedEvent({
              id: "series_20260310T010000Z",
              recurringEventId: "series",
              iCalUID: "series@google.com",
              originalStartTime: { dateTime: "2026-03-10T01:00:00.000Z" },
            }),
            timedEvent({ id: "series_20260311T010000Z", status: "cancelled" }),
          ]);
    });

    const result = await collect(reader);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      recurringEventId: "series",
      iCalUID: "series@google.com",
      originalStartTime: "2026-03-10T01:00:00.000Z",
    });
  });

  it("deduplicates a repeated event across pages of one calendar", async () => {
    const { reader } = scriptedReader((call, index) => {
      if (isCalendarList(call)) {
        return calendarList([PRIMARY]);
      }
      return index === 1
        ? eventsPage([timedEvent({ id: "dup" })], "page-2")
        : eventsPage([timedEvent({ id: "dup" })]);
    });

    const result = await collect(reader);

    expect(result.items).toHaveLength(1);
  });

  it("keeps the same meeting on two calendars as separate provenance", async () => {
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY, SHARED])
        : eventsPage([timedEvent({ id: "shared", iCalUID: "one@google.com" })]);
    });

    const result = await collect(reader);

    expect(
      result.items.map((item) => {
        return item.calendarId;
      }),
    ).toStrictEqual([PRIMARY.id, SHARED.id]);
  });

  it("preserves all-day dates and excludes one that ends at the window start", async () => {
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY])
        : eventsPage([
            {
              id: "holiday",
              status: "confirmed",
              summary: "Holiday",
              start: { date: "2026-03-12" },
              end: { date: "2026-03-13" },
            },
            {
              id: "yesterday",
              status: "confirmed",
              summary: "Yesterday",
              start: { date: "2026-03-09" },
              end: { date: "2026-03-10" },
            },
          ]);
    });

    const result = await collect(reader);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      allDay: true,
      start: "2026-03-12",
      end: "2026-03-13",
      localDayOffset: 2,
    });
  });

  it("marks an unusable event time as limited coverage, not a silent drop", async () => {
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY])
        : eventsPage([
            { id: "broken", status: "confirmed", start: {}, end: {} },
          ]);
    });

    const result = await collect(reader);

    expect(result.items).toStrictEqual([]);
    expect([...result.state.truncations]).toContain("unreadable-event-time");
    expect(result.state.coverage[0]?.outcome).toBe("truncated");
  });

  it("keeps a bounded Retry-After without retrying a rate limit", async () => {
    const { reader, calls } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY])
        : { kind: "rate-limited", retryAfterMs: 30_000 };
    });

    const result = await collect(reader);

    expect(calls).toHaveLength(2);
    expect(result.state.coverage[0]).toMatchObject({
      outcome: "rate-limited",
      retryAfterMs: 30_000,
    });
    expect(result.state.retryAfterMs).toBe(30_000);
  });

  it("caps readable calendars and reports the ones it never read", async () => {
    const many = Array.from({ length: 10 }, (_, index) => {
      return {
        id: `cal-${String(index).padStart(2, "0")}@example.com`,
        summary: `Calendar ${index}`,
        accessRole: "reader",
      };
    });
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call) ? calendarList(many) : eventsPage([]);
    });

    const result = await collect(reader);

    expect(
      result.state.coverage.filter((entry) => {
        return entry.outcome === "not-read";
      }),
    ).toHaveLength(10 - MORNING_BRIEF_CALENDAR_CAPS.maxReadableCalendars);
    expect([...result.state.truncations]).toContain("calendars");
  });

  it("records the reader's budget limit instead of an empty success", async () => {
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY, SHARED])
        : { kind: "budget-exhausted", limit: "deadline" };
    });

    const result = await collect(reader);

    expect([...result.state.truncations]).toContain("deadline");
    expect(
      result.state.coverage.every((entry) => {
        return entry.outcome === "not-read";
      }),
    ).toBeTruthy();
  });

  it("only keeps an http(s) display link and never a private scheme", async () => {
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY])
        : eventsPage([
            timedEvent({ id: "a", htmlLink: "javascript:alert(1)" }),
            timedEvent({
              id: "b",
              htmlLink: "https://calendar.google.com/event?eid=ok",
            }),
          ]);
    });

    const result = await collect(reader);

    expect(result.items[0]?.link).toBeNull();
    expect(result.items[1]?.link).toBe(
      "https://calendar.google.com/event?eid=ok",
    );
  });

  it("bounds attendees and flags the truncation", async () => {
    const attendees = Array.from({ length: 25 }, (_, index) => {
      return {
        email: `person-${index}@example.com`,
        responseStatus: "accepted",
      };
    });
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY])
        : eventsPage([timedEvent({ attendees })]);
    });

    const result = await collect(reader);

    expect(result.items[0]?.attendees).toHaveLength(
      MORNING_BRIEF_CALENDAR_CAPS.maxAttendees,
    );
    expect(result.items[0]?.attendeesTruncated).toBeTruthy();
    expect([...result.state.truncations]).toContain("attendees");
  });

  it("treats a malformed body as a failure rather than an empty calendar", async () => {
    const { reader } = scriptedReader((call) => {
      return isCalendarList(call)
        ? calendarList([PRIMARY])
        : ok({ items: [{ id: 42 }] });
    });

    const result = await collect(reader);

    expect(result.items).toStrictEqual([]);
    expect(result.state.coverage[0]?.outcome).toBe("failed");
  });
});
