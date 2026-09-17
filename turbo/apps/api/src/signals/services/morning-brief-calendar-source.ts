/**
 * Google Calendar's collection, expressed as source-neutral evidence.
 *
 * Calendar is the source where flattening loses the most. An all-day event
 * carries calendar dates with an exclusive end, not a UTC midnight; a timed
 * event that began yesterday and runs into the window overlaps it rather than
 * starting in it; and a recurrence instance is a different record from its
 * series. A brief that collapses those reports a three-day conference as
 * "today" and silently merges two copies of one meeting.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import type {
  MorningBriefCalendarCollection,
  MorningBriefCalendarItem,
} from "@okouai/api-contracts/contracts/morning-brief-calendar-collection-preview";

import {
  morningBriefScopeDigest,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import type {
  MorningBriefSourceCollection,
  MorningBriefSourceCoverage,
  MorningBriefSourceItem,
  MorningBriefTimeSemantics,
} from "./morning-brief-source-item";

/** The Calendar authorization surface a Morning Brief read exercises. */
const MORNING_BRIEF_CALENDAR_READ_SURFACE: readonly string[] = [
  "https://www.googleapis.com/auth/calendar.readonly",
];

/**
 * Which kind of instant this event contributes.
 *
 * An all-day event is a date in the owner's timezone with an exclusive end, so
 * it is never an instant. A timed event that the collector could not place
 * inside the frozen local day — `localDayOffset` is null — reached the window by
 * overlapping it, which is a different claim from starting inside it.
 */
function calendarTimeSemantics(
  item: MorningBriefCalendarItem,
): MorningBriefTimeSemantics {
  if (item.allDay) {
    return "date-only";
  }
  return item.localDayOffset === null ? "overlap" : "instant";
}

function calendarCoverage(
  collection: MorningBriefCalendarCollection,
): MorningBriefSourceCoverage {
  if (collection.status === "unavailable") {
    return "failed";
  }
  if (collection.status === "partial") {
    return "partial";
  }
  return collection.items.length === 0 ? "empty" : "complete";
}

/**
 * The instant an item is ordered and reported by.
 *
 * An all-day event's `start` is a calendar date, so parsing it yields that
 * date's UTC midnight. That is acceptable for ordering precisely because
 * `timeSemantics` already tells the reader it is a date rather than a moment;
 * the exclusive `end` travels separately and is not rounded away.
 */
function calendarInstant(value: string): Date {
  return new Date(value);
}

/**
 * Normalize one Calendar collection.
 *
 * Events are ranked by start, earliest first, which is the order a day is
 * actually lived and the priority the request allocator consumes when Calendar
 * has to give up its later turns.
 */
export function normalizeMorningBriefCalendar(
  collection: MorningBriefCalendarCollection,
  account: string,
): MorningBriefSourceCollection {
  const ranked = [...collection.items].sort((left, right) => {
    return (
      calendarInstant(left.start).getTime() -
      calendarInstant(right.start).getTime()
    );
  });
  const items: MorningBriefSourceItem[] = ranked.map((event, index) => {
    const link = event.link;
    return {
      identity: {
        source: "calendar",
        account,
        container: event.calendarId,
        record: event.eventId,
        // A recurrence instance is its own authorized record. Keeping the
        // original start here is what stops two occurrences of one series from
        // deduplicating into a single meeting.
        instance:
          event.recurringEventId === null ? null : event.originalStartTime,
      },
      priority: index,
      occurredAt: calendarInstant(event.start),
      timeSemantics: calendarTimeSemantics(event),
      endsAt: calendarInstant(event.end),
      title: event.summary ?? "",
      body: event.descriptionExcerpt ?? "",
      // The collector declares when it clipped an attendee list; the excerpt
      // itself is bounded by that same read.
      truncated: event.attendeesTruncated,
      links: link === null ? [] : [{ label: "Open in Calendar", url: link }],
    };
  });
  return {
    source: "calendar",
    coverage: calendarCoverage(collection),
    items,
    requests: collection.coverage.calendars.length,
    omittedBySource: 0,
  };
}

/**
 * The credential-free descriptor a later phase revalidates Calendar against.
 *
 * `containers` names the calendars that actually contributed, so a later check
 * can ask whether those exact calendars are still readable rather than trusting
 * a digest of constants.
 */
export function morningBriefCalendarDescriptor(args: {
  readonly accountRef: string | null;
  readonly connectionId: string | null;
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: Date;
  readonly contributed: boolean;
  readonly containers: readonly string[];
}): MorningBriefRetainedSourceDescriptor {
  return {
    source: "calendar",
    connectionId: args.connectionId,
    accountRef: args.accountRef,
    scopeDigest: morningBriefScopeDigest(MORNING_BRIEF_CALENDAR_READ_SURFACE),
    membershipId: args.membershipId,
    agentId: args.agentId,
    capturedAt: args.capturedAt.toISOString(),
    contributed: args.contributed,
    containers: args.containers,
  };
}
