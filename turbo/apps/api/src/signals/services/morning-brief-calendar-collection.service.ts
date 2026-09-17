import type {
  MorningBriefCalendarCollection,
  MorningBriefCalendarItem,
  MorningBriefCalendarOutcome,
  MorningBriefCalendarTruncation,
} from "@okouai/api-contracts/contracts/morning-brief-calendar-collection-preview";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import type { ClerkClient } from "../external/clerk";
import type { Db } from "../external/db";
import { joinAll, safeSync } from "../utils";
import {
  withMorningBriefConnectorReader,
  type MorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
  type MorningBriefSourceAuthorityLedger,
  type MorningBriefConnectorReader,
  type MorningBriefReadOutcome,
  type MorningBriefResponseMetadata,
} from "./morning-brief-connector-reader.service";
import {
  checkAllDayRange,
  checkTimedRange,
  formatCalendarDate,
  localDayOffsetOf,
  parseCalendarDate,
  parseCalendarDateTime,
  resolveMorningBriefCalendarWindow,
  type MorningBriefCalendarWindow,
} from "./morning-brief-calendar-window";

/**
 * Bounded multi-calendar collection for Simple Morning Brief.
 *
 * This module owns Google Calendar semantics only: which calendars are
 * readable, the frozen local-day window, and how events normalize. Authority,
 * the credential, the host and the request/byte/deadline ceilings all live in
 * the shared Morning Brief connector reader, which re-authorizes before
 * credentials, before every request and again before the payload is released.
 *
 * It is deliberately not the webhook sync reader: that one is unbounded and
 * renders date-only values through UTC midnight, which misplaces every all-day
 * event outside UTC.
 */

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/";
const CALENDAR_CONNECTOR_SLUG = "google-calendar" as const;
const CALENDAR_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_CALENDAR_TOKEN";

const MORNING_BRIEF_CALENDAR_CAPS = Object.freeze({
  calendarListPages: 2,
  calendarListPageSize: 50,
  maxReadableCalendars: 8,
  eventPagesPerCalendar: 2,
  eventPageSize: 50,
  maxEvents: 200,
  maxRequests: 18,
  concurrency: 2,
  deadlineMs: 20_000,
  maxResponseBytes: 256 * 1024,
  maxTotalResponseBytes: 2 * 1024 * 1024,
  maxAttendees: 20,
  maxDescriptionCharacters: 500,
  maxSummaryCharacters: 200,
  maxLocationCharacters: 200,
  maxTextCharacters: 40_000,
});

/**
 * The whole-source budget, started by the composition that admits this source
 * rather than by the reader, so the identity preflight that admits it spends
 * the same deadline the provider requests do.
 */
export const MORNING_BRIEF_CALENDAR_SOURCE_BUDGET_MS =
  MORNING_BRIEF_CALENDAR_CAPS.deadlineMs;

/**
 * Ceilings for the retained fields the provider can make arbitrarily long.
 *
 * A provider string is transport-valid long before it is reasonable, and every
 * one of these reaches composition, so each is projected to what its field
 * legitimately carries and then charged to the final text budget. None of them
 * widens a request, byte, event or aggregate cap: they only decide how much of
 * an arrived response is kept.
 *
 * `identity` and `link` are different in kind. Shortening an event id, a
 * recurrence id or a URL does not shorten a value — it names a different event
 * or a different page — so those are kept whole or dropped, never clipped.
 */
const MORNING_BRIEF_CALENDAR_FIELD_CAPS = Object.freeze({
  /** A Google calendar id, event id, `iCalUID` or recurrence id. */
  identity: 512,
  /** An RFC 3339 instant or a calendar date, with room for an offset. */
  instant: 64,
  /** An IANA timezone name. */
  timezone: 64,
  /** A documented provider label such as `needsAction` or `freeBusyReader`. */
  label: 64,
  /** A Google Calendar `htmlLink`; browsers stop honouring far longer URLs. */
  link: 2048,
});

const READABLE_ACCESS_ROLES = ["reader", "writer", "owner"] as const;
type ReadableAccessRole = (typeof READABLE_ACCESS_ROLES)[number];

const calendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        timeZone: z.string().optional(),
        accessRole: z.string().optional(),
        primary: z.boolean().optional(),
        deleted: z.boolean().optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const eventDateTimeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

const eventSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  htmlLink: z.string().optional(),
  iCalUID: z.string().optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: eventDateTimeSchema.optional(),
  start: eventDateTimeSchema.optional(),
  end: eventDateTimeSchema.optional(),
  organizer: z
    .object({
      email: z.string().optional(),
      displayName: z.string().optional(),
    })
    .optional(),
  attendees: z
    .array(
      z.object({
        email: z.string().optional(),
        displayName: z.string().optional(),
        responseStatus: z.string().optional(),
        self: z.boolean().optional(),
        optional: z.boolean().optional(),
        resource: z.boolean().optional(),
      }),
    )
    .optional(),
  attendeesOmitted: z.boolean().optional(),
});

const eventsPageSchema = z.object({
  items: z.array(eventSchema).optional(),
  nextPageToken: z.string().optional(),
});

const CALENDAR_LIST_FIELDS =
  "nextPageToken,items(id,summary,summaryOverride,timeZone,accessRole,primary,deleted)";
const EVENT_FIELDS =
  "nextPageToken,items(id,status,summary,location,description,htmlLink,iCalUID,recurringEventId,originalStartTime,start,end,organizer,attendees,attendeesOmitted)";

interface SelectedCalendar {
  readonly id: string;
  /** The encoded path segment, proven representable before selection. */
  readonly pathId: string;
  readonly summary: string | null;
  readonly timezone: string | null;
  readonly accessRole: ReadableAccessRole;
  readonly primary: boolean;
}

interface CoverageEntry {
  readonly calendarId: string;
  readonly summary: string | null;
  readonly accessRole: string | null;
  readonly primary: boolean;
  readonly outcome: MorningBriefCalendarOutcome;
  readonly retryAfterMs: number | null;
}

/** Everything one collection accumulates outside the reader's own ceilings. */
class CollectionState {
  readonly truncations = new Set<MorningBriefCalendarTruncation>();
  /**
   * Calendars the list named but never read. Read calendars are appended in
   * the stable selection order once every worker has been joined, so two
   * workers racing cannot reorder the reported coverage.
   */
  readonly coverage: CoverageEntry[] = [];
  retryAfterMs: number | null = null;
  /** Set only by a proven `rate-limited` outcome, never by a retry hint. */
  rateLimited = false;
  /** Set when the list named a calendar whose access role is uninterpretable. */
  unknownAccess = false;
  /** Latched once the reader reports the whole source is gone. */
  revoked = false;

  noteLimit(
    limit: Extract<
      MorningBriefReadOutcome<unknown>,
      { kind: "budget-exhausted" }
    >["limit"],
  ): void {
    this.truncations.add(
      limit === "total-requests"
        ? "total-requests"
        : limit === "deadline"
          ? "deadline"
          : "total-response-bytes",
    );
  }

  /** Bounded provider metadata is recorded, never acted on with a sleep. */
  noteMetadata(meta: MorningBriefResponseMetadata): void {
    this.noteRetryAfter(meta.retryAfterMs);
  }

  noteRetryAfter(retryAfterMs: number | null): void {
    if (retryAfterMs !== null) {
      this.retryAfterMs =
        this.retryAfterMs === null
          ? retryAfterMs
          : Math.min(this.retryAfterMs, retryAfterMs);
    }
  }
}

/** What is left of the caps the whole collection shares. */
interface OutputBudget {
  events: number;
  characters: number;
}

function emptyBudget(): OutputBudget {
  return {
    events: MORNING_BRIEF_CALENDAR_CAPS.maxEvents,
    characters: MORNING_BRIEF_CALENDAR_CAPS.maxTextCharacters,
  };
}

/** Why one item could not be admitted, or `null` when it was. */
function admit(
  budget: OutputBudget,
  cost: number,
): Extract<
  MorningBriefCalendarTruncation,
  "events" | "text-characters"
> | null {
  if (budget.events <= 0) {
    return "events";
  }
  if (cost > budget.characters) {
    return "text-characters";
  }
  budget.events -= 1;
  budget.characters -= cost;
  return null;
}

/** How a failed read maps onto this calendar's coverage. */
function outcomeForFailure(
  outcome: Exclude<MorningBriefReadOutcome<unknown>, { kind: "ok" }>,
  state: CollectionState,
): MorningBriefCalendarOutcome {
  switch (outcome.kind) {
    case "denied": {
      // Endpoint-local, for both this member's effective policy and a provider
      // 403. A provider 403 carrying `Retry-After` is a secondary rate limit,
      // so its bounded metadata is kept for the coverage entry.
      state.noteMetadata(outcome.meta);
      return "denied";
    }
    case "not-found": {
      return "not-found";
    }
    case "rate-limited": {
      // The provider throttled this read whether or not it said for how long,
      // so the fact is latched here rather than inferred from a retry hint.
      state.rateLimited = true;
      state.noteMetadata(outcome.meta);
      state.noteRetryAfter(outcome.retryAfterMs);
      return "rate-limited";
    }
    case "too-large": {
      state.truncations.add("response-bytes");
      return "failed";
    }
    case "budget-exhausted": {
      state.noteLimit(outcome.limit);
      return "not-read";
    }
    case "revoked": {
      state.revoked = true;
      return "failed";
    }
    default: {
      return "failed";
    }
  }
}

function truncate(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Only an absolute HTTP(S) display link survives, and it is never fetched.
 *
 * A link past its ceiling is dropped rather than clipped: the prefix of a URL
 * is a different URL, so rebuilding one would hand the reader a link the
 * provider never issued.
 */
function safeDisplayLink(
  value: string | undefined,
  truncations: Set<MorningBriefCalendarTruncation>,
): string | null {
  if (value === undefined) {
    return null;
  }
  const parsed = URL.parse(value);
  if (parsed === null) {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  const href = parsed.toString();
  if (href.length > MORNING_BRIEF_CALENDAR_FIELD_CAPS.link) {
    truncations.add("oversized-link");
    return null;
  }
  return href;
}

/**
 * A value that is kept exactly or not at all.
 *
 * `false` means the provider sent one this collection cannot carry. Fields
 * that name something — an id, a recurrence instant, a URL — have no shorter
 * form: a prefix is a different name, so their owner declares a gap instead.
 */
function exact(value: string, max: number): string | false {
  return value.length <= max ? value : false;
}

/** The optional form of {@link exact}; `null` is a normal absence. */
function exactOrAbsent(
  value: string | undefined,
  max: number,
): string | null | false {
  return value === undefined ? null : exact(value, max);
}

/**
 * The path segment this calendar id becomes, or `null` when it has none.
 *
 * A lone surrogate is a valid JSON string and an impossible URL component, so
 * the encoding is proven here, once, instead of throwing out of the worker
 * that would have issued the request.
 */
function calendarPathId(id: string): string | null {
  if (exact(id, MORNING_BRIEF_CALENDAR_FIELD_CAPS.identity) === false) {
    return null;
  }
  const encoded = safeSync(() => {
    return encodeURIComponent(id);
  });
  return "ok" in encoded ? encoded.ok : null;
}

function readableAccessRole(
  value: string | undefined,
): ReadableAccessRole | null {
  return (
    READABLE_ACCESS_ROLES.find((role) => {
      return role === value;
    }) ?? null
  );
}

interface CalendarListOutcome {
  readonly selected: readonly SelectedCalendar[];
  readonly listCoverage: MorningBriefCalendarCollection["coverage"]["calendarList"];
}

/**
 * Enumerates the calendars this account may actually read events from.
 *
 * A denied list stays denied. Falling back to `primary` would claim coverage
 * the account never proved it has. Every entry the list names leaves the loop
 * either selected or declared: an entry that is silently skipped would make an
 * account this reader cannot interpret look like an account with nothing on.
 */
async function enumerateCalendars(
  reader: MorningBriefConnectorReader,
  state: CollectionState,
): Promise<CalendarListOutcome> {
  const readable: SelectedCalendar[] = [];
  let pageToken: string | undefined;
  let listCoverage: CalendarListOutcome["listCoverage"] = "complete";

  for (
    let page = 0;
    page < MORNING_BRIEF_CALENDAR_CAPS.calendarListPages;
    page += 1
  ) {
    const result = await reader.getJson({
      pathname: "users/me/calendarList",
      query: {
        maxResults: String(MORNING_BRIEF_CALENDAR_CAPS.calendarListPageSize),
        showDeleted: "false",
        showHidden: "true",
        fields: CALENDAR_LIST_FIELDS,
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      schema: calendarListSchema,
    });

    if (result.kind !== "ok") {
      const outcome = outcomeForFailure(result, state);
      return {
        selected: [],
        listCoverage:
          outcome === "denied" || outcome === "not-found"
            ? "denied"
            : outcome === "not-read"
              ? "truncated"
              : "failed",
      };
    }
    state.noteMetadata(result.meta);

    for (const entry of result.value.items ?? []) {
      if (entry.deleted === true) {
        continue;
      }
      const pathId = calendarPathId(entry.id);
      if (pathId === null) {
        // Its own coverage entry would have to name it, and a clipped calendar
        // id names a different calendar, so the limit is reported without one.
        state.truncations.add("oversized-identity");
        continue;
      }
      const summary = truncate(
        entry.summaryOverride ?? entry.summary,
        MORNING_BRIEF_CALENDAR_CAPS.maxSummaryCharacters,
      );
      const role = readableAccessRole(entry.accessRole);
      if (role === null) {
        // `freeBusyReader` sees busy blocks, never event detail, and an
        // unrecognized or missing role is a calendar whose contents stay
        // unknown. Both are coverage limits rather than silent omissions.
        const known = entry.accessRole === "freeBusyReader";
        if (!known) {
          state.unknownAccess = true;
        }
        state.coverage.push({
          calendarId: entry.id,
          summary,
          accessRole: truncate(
            entry.accessRole,
            MORNING_BRIEF_CALENDAR_FIELD_CAPS.label,
          ),
          primary: entry.primary === true,
          outcome: known ? "free-busy-only" : "unknown-access",
          retryAfterMs: null,
        });
        continue;
      }
      readable.push({
        id: entry.id,
        pathId,
        summary,
        timezone: truncate(
          entry.timeZone,
          MORNING_BRIEF_CALENDAR_FIELD_CAPS.timezone,
        ),
        accessRole: role,
        primary: entry.primary === true,
      });
    }

    pageToken = result.value.nextPageToken;
    if (pageToken === undefined) {
      break;
    }
    if (page === MORNING_BRIEF_CALENDAR_CAPS.calendarListPages - 1) {
      // A continuation token we will not follow is unknown coverage.
      state.truncations.add("calendar-list-pages");
      listCoverage = "truncated";
    }
  }

  // Primary first inside the set actually enumerated, then stable by ID.
  const ordered = [...readable].sort((left, right) => {
    if (left.primary !== right.primary) {
      return left.primary ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
  const selected = ordered.slice(
    0,
    MORNING_BRIEF_CALENDAR_CAPS.maxReadableCalendars,
  );
  for (const dropped of ordered.slice(
    MORNING_BRIEF_CALENDAR_CAPS.maxReadableCalendars,
  )) {
    state.truncations.add("calendars");
    state.coverage.push({
      calendarId: dropped.id,
      summary: dropped.summary,
      accessRole: dropped.accessRole,
      primary: dropped.primary,
      outcome: "not-read",
      retryAfterMs: null,
    });
  }
  return { selected, listCoverage };
}

interface NormalizedTime {
  readonly allDay: boolean;
  readonly start: string;
  readonly end: string;
  readonly timezone: string | null;
  readonly localDayOffset: number | null;
  readonly inWindow: boolean;
}

function localDateOf(
  instant: Date,
  timezone: string,
): ReturnType<typeof parseCalendarDate> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    return (
      parts.find((part) => {
        return part.type === type;
      })?.value ?? ""
    );
  };
  return parseCalendarDate(
    `${value("year")}-${value("month")}-${value("day")}`,
  );
}

type EventTime = z.infer<typeof eventDateTimeSchema>;

/**
 * Which representation one endpoint actually states.
 *
 * Google states exactly one of `date` or `dateTime` per endpoint. Carrying
 * both, or neither, describes two different moments or none, so it is not a
 * value this collector is willing to pick a winner from.
 */
function endpointKind(time: EventTime): "date" | "dateTime" | null {
  const hasDate = time.date !== undefined;
  const hasDateTime = time.dateTime !== undefined;
  if (hasDate === hasDateTime) {
    return null;
  }
  return hasDate ? "date" : "dateTime";
}

/** The zone an event declares for itself, used only as reported provenance. */
function declaredTimezone(start: EventTime, end: EventTime): string | null {
  return start.timeZone ?? end.timeZone ?? null;
}

/** An all-day pair: calendar dates with an exclusive end, never instants. */
function normalizeAllDay(
  start: EventTime,
  end: EventTime,
  window: MorningBriefCalendarWindow,
): NormalizedTime | null {
  const startDate =
    start.date === undefined ? null : parseCalendarDate(start.date);
  const endDate = end.date === undefined ? null : parseCalendarDate(end.date);
  if (startDate === null || endDate === null) {
    return null;
  }
  const placement = checkAllDayRange({
    start: startDate,
    endExclusive: endDate,
    window,
  });
  if (placement === "invalid-range") {
    return null;
  }
  return {
    allDay: true,
    start: formatCalendarDate(startDate),
    end: formatCalendarDate(endDate),
    timezone: declaredTimezone(start, end),
    localDayOffset: localDayOffsetOf(window, startDate),
    inWindow: placement === "in-window",
  };
}

/** A timed pair, resolved to instants without consulting the machine clock. */
function normalizeTimed(
  start: EventTime,
  end: EventTime,
  window: MorningBriefCalendarWindow,
): NormalizedTime | null {
  if (start.dateTime === undefined || end.dateTime === undefined) {
    return null;
  }
  // Each endpoint is resolved against its own declared zone: a flight may
  // legitimately start and end in different ones, and neither borrows context
  // from the other.
  const startParsed = parseCalendarDateTime({
    value: start.dateTime,
    timeZone: start.timeZone,
  });
  const endParsed = parseCalendarDateTime({
    value: end.dateTime,
    timeZone: end.timeZone,
  });
  if (!startParsed.ok || !endParsed.ok) {
    return null;
  }
  const startAt = startParsed.instant;
  const endAt = endParsed.instant;
  const placement = checkTimedRange({ startAt, endAt, window });
  if (placement === "invalid-range") {
    return null;
  }
  const localDate = localDateOf(startAt, window.timezone);
  return {
    allDay: false,
    start: startAt.toISOString(),
    end: endAt.toISOString(),
    timezone: declaredTimezone(start, end),
    localDayOffset:
      localDate === null ? null : localDayOffsetOf(window, localDate),
    inWindow: placement === "in-window",
  };
}

/**
 * The window placement of one event, or `null` when its time is unreadable.
 *
 * Every `null` here is an explicit coverage gap at the call site, never a
 * silent drop. The alternative — letting a lenient parse or a reversed interval
 * through — turns an impossible date into a meeting the recipient never had.
 */
function normalizeTime(
  event: z.infer<typeof eventSchema>,
  window: MorningBriefCalendarWindow,
): NormalizedTime | null {
  const start = event.start;
  const end = event.end;
  if (start === undefined || end === undefined) {
    return null;
  }
  const kind = endpointKind(start);
  // A mixed event claims to be all-day at one end and timed at the other.
  if (kind === null || kind !== endpointKind(end)) {
    return null;
  }
  return kind === "date"
    ? normalizeAllDay(start, end, window)
    : normalizeTimed(start, end, window);
}

/**
 * Normalize one event, or report that it cannot be represented.
 *
 * `null` means an identity this item is addressed by arrived longer than the
 * ceiling. Keeping a prefix would silently rename the event, collide it with a
 * sibling or point a recurrence instance at the wrong occurrence, so the whole
 * item is dropped and its calendar declares the gap.
 */
function normalizeEvent(
  event: z.infer<typeof eventSchema>,
  calendar: SelectedCalendar,
  time: NormalizedTime,
  state: CollectionState,
): MorningBriefCalendarItem | null {
  const identity = MORNING_BRIEF_CALENDAR_FIELD_CAPS.identity;
  const eventId = exact(event.id, identity);
  const iCalUID = exactOrAbsent(event.iCalUID, identity);
  const recurringEventId = exactOrAbsent(event.recurringEventId, identity);
  const originalStartTime = exactOrAbsent(
    event.originalStartTime?.dateTime ?? event.originalStartTime?.date,
    MORNING_BRIEF_CALENDAR_FIELD_CAPS.instant,
  );
  if (
    eventId === false ||
    iCalUID === false ||
    recurringEventId === false ||
    originalStartTime === false
  ) {
    return null;
  }

  const attendees = (event.attendees ?? []).filter((attendee) => {
    return attendee.resource !== true;
  });
  const kept = attendees.slice(0, MORNING_BRIEF_CALENDAR_CAPS.maxAttendees);
  const attendeesTruncated =
    event.attendeesOmitted === true ||
    attendees.length > MORNING_BRIEF_CALENDAR_CAPS.maxAttendees;
  if (attendeesTruncated) {
    state.truncations.add("attendees");
  }
  const self = attendees.find((attendee) => {
    return attendee.self === true;
  });

  return {
    calendarId: calendar.id,
    calendarSummary: calendar.summary,
    calendarTimezone: calendar.timezone,
    eventId,
    iCalUID,
    recurringEventId,
    originalStartTime,
    summary: truncate(
      event.summary,
      MORNING_BRIEF_CALENDAR_CAPS.maxSummaryCharacters,
    ),
    location: truncate(
      event.location,
      MORNING_BRIEF_CALENDAR_CAPS.maxLocationCharacters,
    ),
    descriptionExcerpt: truncate(
      event.description,
      MORNING_BRIEF_CALENDAR_CAPS.maxDescriptionCharacters,
    ),
    allDay: time.allDay,
    start: time.start,
    end: time.end,
    eventTimezone: truncate(
      time.timezone,
      MORNING_BRIEF_CALENDAR_FIELD_CAPS.timezone,
    ),
    localDayOffset: time.localDayOffset,
    organizer: truncate(
      event.organizer?.displayName ?? event.organizer?.email,
      MORNING_BRIEF_CALENDAR_CAPS.maxSummaryCharacters,
    ),
    selfResponseStatus: truncate(
      self?.responseStatus,
      MORNING_BRIEF_CALENDAR_FIELD_CAPS.label,
    ),
    attendees: kept.flatMap((attendee) => {
      const label = truncate(
        attendee.displayName ?? attendee.email,
        MORNING_BRIEF_CALENDAR_CAPS.maxSummaryCharacters,
      );
      return label === null
        ? []
        : [
            {
              label,
              responseStatus: truncate(
                attendee.responseStatus,
                MORNING_BRIEF_CALENDAR_FIELD_CAPS.label,
              ),
              optional: attendee.optional === true,
            },
          ];
    }),
    attendeesTruncated,
    link: safeDisplayLink(event.htmlLink, state.truncations),
  };
}

/**
 * The characters this item actually contributes to the final output.
 *
 * Every provider-derived string a composed brief can read is charged, the
 * provenance repeated on each item included. A calendar name, an organizer or a
 * display link that is retained for free is still text the brief has to carry,
 * and counting a subset of the retained fields is what let 200 items promise
 * 40,000 characters while holding 100,000.
 */
function itemTextCost(item: MorningBriefCalendarItem): number {
  // The inventory is written out so that a field added to the contract without
  // being charged here is visible as an omission rather than hidden in a sum.
  const retained: readonly (string | null)[] = [
    item.calendarId,
    item.calendarSummary,
    item.calendarTimezone,
    item.eventId,
    item.iCalUID,
    item.recurringEventId,
    item.originalStartTime,
    item.summary,
    item.location,
    item.descriptionExcerpt,
    item.start,
    item.end,
    item.eventTimezone,
    item.organizer,
    item.selfResponseStatus,
    item.link,
    ...item.attendees.flatMap((attendee) => {
      return [attendee.label, attendee.responseStatus];
    }),
  ];
  return retained.reduce((total, value) => {
    return total + (value?.length ?? 0);
  }, 0);
}

/**
 * The bounded wait this calendar's failure advertises, if any.
 *
 * A provider `403` that carries `Retry-After` is a secondary rate limit on this
 * endpoint rather than a lost credential, so it reports a wait just as an
 * explicit `429` does. It is recorded, never slept on.
 */
function failureRetryAfterMs(
  outcome: Exclude<MorningBriefReadOutcome<unknown>, { kind: "ok" }>,
): number | null {
  if (outcome.kind === "rate-limited") {
    return outcome.retryAfterMs;
  }
  return outcome.kind === "denied" ? outcome.meta.retryAfterMs : null;
}

/** What one calendar produced, before the shared caps are applied to it. */
interface CalendarRead {
  readonly calendar: SelectedCalendar;
  readonly items: readonly MorningBriefCalendarItem[];
  readonly outcome: MorningBriefCalendarOutcome;
  readonly retryAfterMs: number | null;
}

/**
 * Reads one calendar's events over the frozen window.
 *
 * Nothing is charged to the shared caps here. A worker that spent the shared
 * budget as its pages arrived would let network timing decide which calendars
 * reach the brief, so a calendar only collects up to what the shared caps could
 * ever grant it and the allocation itself happens once, in a stable order,
 * after every worker has been joined.
 */
async function readCalendar(args: {
  readonly reader: MorningBriefConnectorReader;
  readonly calendar: SelectedCalendar;
  readonly window: MorningBriefCalendarWindow;
  readonly state: CollectionState;
}): Promise<CalendarRead> {
  const { calendar, reader, state, window } = args;
  const items: MorningBriefCalendarItem[] = [];
  const seen = new Set<string>();
  const budget = emptyBudget();
  let outcome: MorningBriefCalendarOutcome = "complete";
  let retryAfterMs: number | null = null;
  let pageToken: string | undefined;

  for (
    let page = 0;
    page < MORNING_BRIEF_CALENDAR_CAPS.eventPagesPerCalendar;
    page += 1
  ) {
    if (state.revoked) {
      outcome = items.length > 0 ? "truncated" : "not-read";
      break;
    }
    const result = await reader.getJson({
      pathname: `calendars/${calendar.pathId}/events`,
      query: {
        timeMin: window.startAt.toISOString(),
        timeMax: window.endAt.toISOString(),
        singleEvents: "true",
        showDeleted: "false",
        orderBy: "startTime",
        maxResults: String(MORNING_BRIEF_CALENDAR_CAPS.eventPageSize),
        fields: EVENT_FIELDS,
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      schema: eventsPageSchema,
    });

    if (result.kind !== "ok") {
      const failure = outcomeForFailure(result, state);
      // Partial content already collected stays, but the calendar is no
      // longer a complete read.
      outcome =
        items.length > 0 && (failure === "not-read" || failure === "failed")
          ? "truncated"
          : failure;
      retryAfterMs = failureRetryAfterMs(result);
      break;
    }
    state.noteMetadata(result.meta);

    let capped = false;
    for (const event of result.value.items ?? []) {
      if (event.status === "cancelled") {
        continue;
      }
      if (seen.has(event.id)) {
        continue;
      }
      const time = normalizeTime(event, window);
      if (time === null) {
        state.truncations.add("unreadable-event-time");
        outcome = "truncated";
        continue;
      }
      if (!time.inWindow) {
        continue;
      }
      const item = normalizeEvent(event, calendar, time, state);
      if (item === null) {
        // A valid sibling in the same response still survives it.
        state.truncations.add("oversized-identity");
        outcome = "truncated";
        continue;
      }
      const refused = admit(budget, itemTextCost(item));
      if (refused !== null) {
        // One calendar alone reached a shared cap, so the limit that stopped
        // it is named here as well as on this calendar's coverage entry.
        state.truncations.add(refused);
        capped = true;
        outcome = "truncated";
        break;
      }
      seen.add(event.id);
      items.push(item);
    }
    if (capped) {
      break;
    }

    pageToken = result.value.nextPageToken;
    if (pageToken === undefined) {
      break;
    }
    if (page === MORNING_BRIEF_CALENDAR_CAPS.eventPagesPerCalendar - 1) {
      // A continuation token survived the page cap, so this calendar is
      // partial even though every issued request succeeded.
      state.truncations.add("event-pages");
      outcome = "truncated";
    }
  }

  return { calendar, items, outcome, retryAfterMs };
}

/**
 * Runs the per-calendar reads at the allowed concurrency, in stable order.
 *
 * Both workers are started, so both are joined. A worker that rejects — the
 * shared reader turns caller cancellation into exactly that — must not let this
 * function settle while its sibling is still reading: the collection would
 * return while a started provider read was still in flight and unobserved. The
 * first error still propagates, and cancellation is never masked.
 */
async function readCalendars(args: {
  readonly reader: MorningBriefConnectorReader;
  readonly calendars: readonly SelectedCalendar[];
  readonly window: MorningBriefCalendarWindow;
  readonly state: CollectionState;
}): Promise<readonly CalendarRead[]> {
  const collected = new Map<number, CalendarRead>();
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const calendar = args.calendars[index];
      if (calendar === undefined) {
        return;
      }
      collected.set(
        index,
        await readCalendar({
          reader: args.reader,
          calendar,
          window: args.window,
          state: args.state,
        }),
      );
    }
  };

  await joinAll(
    Array.from(
      {
        length: Math.min(
          MORNING_BRIEF_CALENDAR_CAPS.concurrency,
          Math.max(args.calendars.length, 1),
        ),
      },
      worker,
    ),
  );

  return args.calendars.flatMap((_, index) => {
    const read = collected.get(index);
    return read === undefined ? [] : [read];
  });
}

/**
 * Applies the shared event and character caps, once, in the selection order.
 *
 * This is where the collection's promised output size is actually enforced, so
 * it charges what each item really retains. The first item that does not fit
 * stops the allocation: everything after it belongs to a brief that was already
 * full, and reporting a later small event while dropping an earlier one would
 * reorder the owner's day.
 */
function admitReadCalendars(
  reads: readonly CalendarRead[],
  state: CollectionState,
): readonly MorningBriefCalendarItem[] {
  const budget = emptyBudget();
  const admitted: MorningBriefCalendarItem[] = [];
  let full = false;

  for (const read of reads) {
    const kept: MorningBriefCalendarItem[] = [];
    for (const item of read.items) {
      if (full) {
        break;
      }
      const refused = admit(budget, itemTextCost(item));
      if (refused !== null) {
        state.truncations.add(refused);
        full = true;
        break;
      }
      kept.push(item);
    }
    admitted.push(...kept);
    state.coverage.push({
      calendarId: read.calendar.id,
      summary: read.calendar.summary,
      accessRole: read.calendar.accessRole,
      primary: read.calendar.primary,
      // A calendar that was read completely but could not be carried whole is
      // still a shortened calendar, never a complete one.
      outcome:
        kept.length < read.items.length && read.outcome === "complete"
          ? "truncated"
          : read.outcome,
      retryAfterMs: read.retryAfterMs,
    });
  }
  return admitted;
}

interface CollectedCalendars {
  readonly items: readonly MorningBriefCalendarItem[];
  readonly listCoverage: MorningBriefCalendarCollection["coverage"]["calendarList"];
  readonly readable: number;
  readonly state: CollectionState;
}

/** The provider-facing half: enumerate, then read, inside one authorized reader. */
async function collectCalendarsWithReader(args: {
  readonly reader: MorningBriefConnectorReader;
  readonly window: MorningBriefCalendarWindow;
}): Promise<CollectedCalendars> {
  const state = new CollectionState();
  const list = await enumerateCalendars(args.reader, state);
  const readable = list.selected.length;
  if (readable === 0) {
    return { items: [], listCoverage: list.listCoverage, readable, state };
  }
  const reads = await readCalendars({
    reader: args.reader,
    calendars: list.selected,
    window: args.window,
    state,
  });
  return {
    items: admitReadCalendars(reads, state),
    listCoverage: list.listCoverage,
    readable,
    state,
  };
}

/**
 * A cap, a denied calendar, an unfollowed page or a provider failure is never
 * a healthy empty day. Only a complete read with nothing in it is `empty`.
 *
 * An account with no readable calendar read nothing at all, so it cannot be
 * quiet either: `empty` has to mean a calendar was actually opened and found
 * to hold nothing.
 */
function collectionStatus(args: {
  readonly itemCount: number;
  readonly listCoverage: CollectedCalendars["listCoverage"];
  readonly readable: number;
  readonly coverage: readonly CoverageEntry[];
  readonly truncations: ReadonlySet<MorningBriefCalendarTruncation>;
}): MorningBriefCalendarCollection["status"] {
  const complete =
    args.listCoverage === "complete" &&
    args.readable > 0 &&
    args.truncations.size === 0 &&
    args.coverage.every((entry) => {
      return entry.outcome === "complete";
    });
  if (complete) {
    return args.itemCount > 0 ? "ok" : "empty";
  }
  return args.itemCount > 0 ? "partial" : "unavailable";
}

function unavailable(args: {
  readonly scope: MorningBriefCollectionScope;
  readonly window: MorningBriefCalendarWindow;
  readonly collectedAt: Date;
  readonly failure: MorningBriefCalendarCollection["failure"];
}): MorningBriefCalendarCollection {
  return {
    ...envelope(args.scope, args.window, args.collectedAt),
    status: "unavailable",
    items: [],
    coverage: {
      calendarList: "failed",
      calendars: [],
      truncations: [],
      requests: 0,
      retryAfterMs: null,
    },
    failure: args.failure,
  };
}

function envelope(
  scope: MorningBriefCollectionScope,
  window: MorningBriefCalendarWindow,
  collectedAt: Date,
) {
  return {
    source: "google-calendar",
    anchor: scope.anchor.toISOString(),
    collectedAt: collectedAt.toISOString(),
    timezone: window.timezone,
    window: {
      startAt: window.startAt.toISOString(),
      endAt: window.endAt.toISOString(),
      startDate: formatCalendarDate(window.startDate),
      endDateExclusive: formatCalendarDate(window.endDate),
    },
  } as const;
}

/**
 * Collects the owner's readable calendars for one Morning Brief occurrence.
 *
 * The result is memory-only: nothing is persisted, no provider write is made,
 * and a bounded `Retry-After` is reported rather than slept on.
 */
export async function collectMorningBriefCalendar(
  args: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    /** The account choice frozen for this attempt, and this read's proof. */
    readonly authority: MorningBriefSourceAuthorityLedger;
    /**
     * The source deadline the caller started before admitting this source. It
     * is spent, never restarted, so a slow admission shortens the collection
     * instead of earning it a second allowance.
     */
    readonly deadline: MorningBriefSourceDeadline;
  },
  signal: AbortSignal,
): Promise<MorningBriefCalendarCollection> {
  const collectedAt = nowDate();
  const resolved = resolveMorningBriefCalendarWindow({
    anchor: args.scope.anchor,
    timezone: args.scope.timezone,
  });
  if (!resolved.ok) {
    // An unusable owner timezone is a real state; it never becomes an empty
    // day, and no provider request is issued for it.
    return {
      source: "google-calendar",
      status: "unavailable",
      anchor: args.scope.anchor.toISOString(),
      collectedAt: collectedAt.toISOString(),
      timezone: args.scope.timezone,
      window: {
        startAt: args.scope.anchor.toISOString(),
        endAt: args.scope.anchor.toISOString(),
        startDate: "",
        endDateExclusive: "",
      },
      items: [],
      coverage: {
        calendarList: "failed",
        calendars: [],
        truncations: [],
        requests: 0,
        retryAfterMs: null,
      },
      failure: "provider-failed",
    };
  }
  const window = resolved.window;

  const access = await withMorningBriefConnectorReader(
    {
      scope: args.scope,
      connectorSlug: CALENDAR_CONNECTOR_SLUG,
      apiBase: CALENDAR_API_BASE,
      environmentName: CALENDAR_ACCESS_TOKEN_ENVIRONMENT_NAME,
      budget: {
        maxRequests: MORNING_BRIEF_CALENDAR_CAPS.maxRequests,
        maxResponseBytes: MORNING_BRIEF_CALENDAR_CAPS.maxResponseBytes,
        maxTotalResponseBytes:
          MORNING_BRIEF_CALENDAR_CAPS.maxTotalResponseBytes,
      },
      deadline: args.deadline,
      db: args.db,
      clerk: args.clerk,
      authority: args.authority,
    },
    async (reader) => {
      return await collectCalendarsWithReader({ reader, window });
    },
    signal,
  );

  if (access.kind === "unavailable") {
    return unavailable({
      scope: args.scope,
      window,
      collectedAt,
      failure: access.reason,
    });
  }

  const { items, listCoverage, readable, state } = access.value;
  if (access.truncatedTotalBytes) {
    state.truncations.add("total-response-bytes");
  }
  const truncations = [...state.truncations].sort();
  const status = collectionStatus({
    itemCount: items.length,
    listCoverage,
    readable,
    coverage: state.coverage,
    truncations: state.truncations,
  });

  return {
    ...envelope(args.scope, window, collectedAt),
    status,
    items: [...items],
    coverage: {
      calendarList: listCoverage,
      calendars: state.coverage,
      truncations,
      requests: access.requests,
      retryAfterMs: state.retryAfterMs,
    },
    // Trouble that produced no usable content is reported as a source
    // failure, so an unreadable day can never look like an empty one.
    failure:
      status === "unavailable"
        ? sourceFailure({ listCoverage, readable, state, truncations })
        : null,
  };
}

/**
 * The one reason an unreadable day is attributed to, most specific first.
 *
 * Every branch names something this collection observed. A bounded retry hint
 * is not one of them: a provider `403` carries `Retry-After` while denying an
 * endpoint, and a real `429` often carries none, so throttling is claimed only
 * when a read was actually throttled.
 */
function sourceFailure(args: {
  readonly listCoverage: CollectedCalendars["listCoverage"];
  readonly readable: number;
  readonly state: CollectionState;
  readonly truncations: readonly MorningBriefCalendarTruncation[];
}): MorningBriefCalendarCollection["failure"] {
  if (args.listCoverage === "denied") {
    return "not-authorized";
  }
  if (args.state.rateLimited) {
    return "rate-limited";
  }
  if (args.truncations.includes("deadline")) {
    return "deadline-exceeded";
  }
  if (
    args.readable === 0 &&
    args.listCoverage === "complete" &&
    !args.state.unknownAccess
  ) {
    // The whole list was enumerated and nothing in it grants event detail.
    // That is a scope the account does not hold, not a provider that failed.
    return "not-authorized";
  }
  return "provider-failed";
}
