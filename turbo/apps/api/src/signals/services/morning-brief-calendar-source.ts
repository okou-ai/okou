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
  morningBriefProvenAuthority,
  type MorningBriefSourceAuthorityProof,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import {
  morningBriefItemFacts,
  type MorningBriefSourceCollection,
  type MorningBriefSourceCoverage,
  type MorningBriefSourceItem,
  type MorningBriefSourceProvenance,
} from "./morning-brief-source-item";

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
): "instant" | "overlap" {
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
 * The window this collection's evidence is only true within.
 *
 * The frozen local dates and the owner timezone are the whole reason an all-day
 * date is readable: `2026-09-17` with an exclusive end of `2026-09-18` is one
 * day in Asia/Shanghai and a different range of instants in America/Los_Angeles.
 * Each enumerated calendar keeps its own outcome, so a calendar that answered
 * with busy blocks only is not reported as fully read.
 */
function calendarProvenance(
  collection: MorningBriefCalendarCollection,
): MorningBriefSourceProvenance {
  return {
    startAt: collection.window.startAt,
    endAt: collection.window.endAt,
    startDate: collection.window.startDate,
    endDateExclusive: collection.window.endDateExclusive,
    timezone: collection.timezone,
    observedAt: null,
    collectedAt: collection.collectedAt,
    branches: [
      {
        name: "calendar-list",
        status: collection.coverage.calendarList,
        startAt: null,
        endAt: null,
        observedAt: null,
      },
      ...collection.coverage.calendars.map((calendar) => {
        return {
          name: calendar.calendarId,
          status: calendar.outcome,
          startAt: null,
          endAt: null,
          observedAt: null,
        };
      }),
    ],
    limitations: collection.coverage.truncations,
  };
}

/**
 * Private ordering key only; never serialized as an event instant.
 *
 * `Date.parse` is used only to rank ISO values. Its UTC interpretation never
 * becomes evidence: only real timed values become model-visible instants, while
 * a date-only event stays an exclusive-end range in the frozen local timezone.
 */
function calendarOrderValue(item: MorningBriefCalendarItem): number {
  return Date.parse(item.start);
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
    return calendarOrderValue(left) - calendarOrderValue(right);
  });
  const items = ranked.map((event, index): MorningBriefSourceItem => {
    const link = event.link;
    const common = {
      identity: {
        source: "calendar" as const,
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
      title: event.summary ?? "",
      body: event.descriptionExcerpt ?? "",
      // The collector declares when it clipped an attendee list; the excerpt
      // itself is bounded by that same read.
      truncated: event.attendeesTruncated,
      links: link === null ? [] : [{ label: "Open in Calendar", url: link }],
      facts: morningBriefItemFacts({
        startedAtRaw: event.start,
        endsAtRaw: event.end,
        timezone: event.eventTimezone,
        containerTimezone: event.calendarTimezone,
        localDayOffset: event.localDayOffset,
        seriesId: event.recurringEventId,
        state: event.selfResponseStatus,
        actor: event.organizer,
        limitations: event.attendeesTruncated ? ["attendees"] : [],
      }),
    };
    if (event.allDay) {
      return {
        ...common,
        timeSemantics: "date-only",
        occurredAt: null,
        endsAt: null,
        dateRange: {
          startDate: event.start,
          endDateExclusive: event.end,
          timezone: collection.timezone,
        },
      };
    }
    return {
      ...common,
      timeSemantics: calendarTimeSemantics(event),
      occurredAt: new Date(event.start),
      endsAt: new Date(event.end),
      dateRange: null,
    };
  });
  return {
    source: "calendar",
    coverage: calendarCoverage(collection),
    items,
    // The reads the collector actually issued. The number of enumerated
    // calendars is not that number: one calendar can cost a list page and
    // several event pages, and four requests reported as one envelope makes a
    // budget report that cannot be reconciled with the provider's own.
    requests: collection.coverage.requests,
    provenance: calendarProvenance(collection),
    // No cap here counts the events it did not read, so the remainder is
    // explicitly unknown rather than a fabricated zero.
    omittedBySource: {
      known: 0,
      unknownRemaining:
        collection.coverage.truncations.length > 0 ||
        collection.coverage.calendarList !== "complete" ||
        collection.coverage.calendars.some((calendar) => {
          return calendar.outcome !== "complete";
        }),
    },
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
  /** What this source's reads were actually authorized by, or null. */
  readonly proof: MorningBriefSourceAuthorityProof | null;
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: Date;
  readonly contributed: boolean;
  readonly containers: readonly string[];
}): MorningBriefRetainedSourceDescriptor {
  const proven = morningBriefProvenAuthority(args.proof);
  return {
    source: "calendar",
    connectionId: proven.connectionId,
    // The exact Google account the shared reader pinned, not the member's own
    // user id: a first-party id proves nothing about which calendar account
    // this material came from.
    accountRef: args.proof?.accountRef ?? null,
    scopeDigest: proven.scopeDigest,
    endpoints: proven.endpoints,
    membershipId: args.membershipId,
    agentId: args.agentId,
    capturedAt: args.capturedAt.toISOString(),
    contributed: args.contributed,
    containers: args.containers,
  };
}
