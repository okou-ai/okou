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
import {
  withMorningBriefConnectorReader,
  type MorningBriefCollectionScope,
  type MorningBriefConnectorReader,
  type MorningBriefReadOutcome,
  type MorningBriefResponseMetadata,
} from "./morning-brief-connector-reader.service";
import {
  allDayRangeOverlapsWindow,
  formatCalendarDate,
  localDayOffsetOf,
  parseCalendarDate,
  resolveMorningBriefCalendarWindow,
  timedRangeOverlapsWindow,
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
  readonly coverage: CoverageEntry[] = [];
  readonly seen = new Set<string>();
  retryAfterMs: number | null = null;
  events = 0;
  characters = 0;
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

  /** Accepts an item only while both the event and character caps allow it. */
  admit(cost: number): boolean {
    if (this.events >= MORNING_BRIEF_CALENDAR_CAPS.maxEvents) {
      this.truncations.add("events");
      return false;
    }
    if (
      this.characters + cost >
      MORNING_BRIEF_CALENDAR_CAPS.maxTextCharacters
    ) {
      this.truncations.add("text-characters");
      return false;
    }
    this.events += 1;
    this.characters += cost;
    return true;
  }
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

function truncate(value: string | undefined, max: number): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** Only an absolute HTTP(S) display link survives, and it is never fetched. */
function safeDisplayLink(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const parsed = URL.parse(value);
  if (parsed === null) {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:"
    ? parsed.toString()
    : null;
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
 * the account never proved it has.
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
      const summary = truncate(
        entry.summaryOverride ?? entry.summary,
        MORNING_BRIEF_CALENDAR_CAPS.maxSummaryCharacters,
      );
      const role = readableAccessRole(entry.accessRole);
      if (role === null) {
        // `freeBusyReader` sees busy blocks, never event detail. Reporting it
        // as a coverage limit is the only truthful representation.
        if (entry.accessRole === "freeBusyReader") {
          state.coverage.push({
            calendarId: entry.id,
            summary,
            accessRole: entry.accessRole,
            primary: entry.primary === true,
            outcome: "free-busy-only",
            retryAfterMs: null,
          });
        }
        continue;
      }
      readable.push({
        id: entry.id,
        summary,
        timezone: entry.timeZone ?? null,
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

function normalizeTime(
  event: z.infer<typeof eventSchema>,
  window: MorningBriefCalendarWindow,
): NormalizedTime | null {
  const start = event.start;
  const end = event.end;
  if (start === undefined || end === undefined) {
    return null;
  }

  if (start.date !== undefined || end.date !== undefined) {
    const startDate =
      start.date === undefined ? null : parseCalendarDate(start.date);
    const endDate = end.date === undefined ? null : parseCalendarDate(end.date);
    if (startDate === null || endDate === null) {
      return null;
    }
    return {
      allDay: true,
      start: formatCalendarDate(startDate),
      end: formatCalendarDate(endDate),
      timezone: start.timeZone ?? end.timeZone ?? null,
      localDayOffset: localDayOffsetOf(window, startDate),
      inWindow: allDayRangeOverlapsWindow({
        start: startDate,
        endExclusive: endDate,
        window,
      }),
    };
  }

  if (start.dateTime === undefined || end.dateTime === undefined) {
    return null;
  }
  const startAt = new Date(start.dateTime);
  const endAt = new Date(end.dateTime);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    return null;
  }
  const localDate = localDateOf(startAt, window.timezone);
  return {
    allDay: false,
    start: startAt.toISOString(),
    end: endAt.toISOString(),
    timezone: start.timeZone ?? end.timeZone ?? null,
    localDayOffset:
      localDate === null ? null : localDayOffsetOf(window, localDate),
    inWindow: timedRangeOverlapsWindow({ startAt, endAt, window }),
  };
}

function normalizeEvent(
  event: z.infer<typeof eventSchema>,
  calendar: SelectedCalendar,
  time: NormalizedTime,
  state: CollectionState,
): MorningBriefCalendarItem {
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
    eventId: event.id,
    iCalUID: event.iCalUID ?? null,
    recurringEventId: event.recurringEventId ?? null,
    originalStartTime:
      event.originalStartTime?.dateTime ??
      event.originalStartTime?.date ??
      null,
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
    eventTimezone: time.timezone,
    localDayOffset: time.localDayOffset,
    organizer: truncate(
      event.organizer?.displayName ?? event.organizer?.email,
      MORNING_BRIEF_CALENDAR_CAPS.maxSummaryCharacters,
    ),
    selfResponseStatus: self?.responseStatus ?? null,
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
              responseStatus: attendee.responseStatus ?? null,
              optional: attendee.optional === true,
            },
          ];
    }),
    attendeesTruncated,
    link: safeDisplayLink(event.htmlLink),
  };
}

function itemCost(item: MorningBriefCalendarItem): number {
  return (
    (item.summary?.length ?? 0) +
    (item.location?.length ?? 0) +
    (item.descriptionExcerpt?.length ?? 0) +
    item.attendees.reduce((total, attendee) => {
      return total + attendee.label.length;
    }, 0) +
    item.start.length +
    item.end.length
  );
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

/** Reads one calendar's events over the frozen window. */
async function readCalendar(args: {
  readonly reader: MorningBriefConnectorReader;
  readonly calendar: SelectedCalendar;
  readonly window: MorningBriefCalendarWindow;
  readonly state: CollectionState;
}): Promise<readonly MorningBriefCalendarItem[]> {
  const { calendar, reader, state, window } = args;
  const items: MorningBriefCalendarItem[] = [];
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
      pathname: `calendars/${encodeURIComponent(calendar.id)}/events`,
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
      const key = `${calendar.id} ${event.id}`;
      if (state.seen.has(key)) {
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
      if (!state.admit(itemCost(item))) {
        capped = true;
        outcome = "truncated";
        break;
      }
      state.seen.add(key);
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

  state.coverage.push({
    calendarId: calendar.id,
    summary: calendar.summary,
    accessRole: calendar.accessRole,
    primary: calendar.primary,
    outcome,
    retryAfterMs,
  });
  return items;
}

/** Runs the per-calendar reads at the allowed concurrency, in stable order. */
async function readCalendars(args: {
  readonly reader: MorningBriefConnectorReader;
  readonly calendars: readonly SelectedCalendar[];
  readonly window: MorningBriefCalendarWindow;
  readonly state: CollectionState;
}): Promise<readonly MorningBriefCalendarItem[]> {
  const collected = new Map<number, readonly MorningBriefCalendarItem[]>();
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

  await Promise.all(
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
    return collected.get(index) ?? [];
  });
}

interface CollectedCalendars {
  readonly items: readonly MorningBriefCalendarItem[];
  readonly listCoverage: MorningBriefCalendarCollection["coverage"]["calendarList"];
  readonly state: CollectionState;
}

/** The provider-facing half: enumerate, then read, inside one authorized reader. */
async function collectCalendarsWithReader(args: {
  readonly reader: MorningBriefConnectorReader;
  readonly window: MorningBriefCalendarWindow;
}): Promise<CollectedCalendars> {
  const state = new CollectionState();
  const list = await enumerateCalendars(args.reader, state);
  if (list.selected.length === 0) {
    return { items: [], listCoverage: list.listCoverage, state };
  }
  const items = await readCalendars({
    reader: args.reader,
    calendars: list.selected,
    window: args.window,
    state,
  });
  return { items, listCoverage: list.listCoverage, state };
}

/**
 * A cap, a denied calendar, an unfollowed page or a provider failure is never
 * a healthy empty day. Only a complete read with nothing in it is `empty`.
 */
function collectionStatus(args: {
  readonly itemCount: number;
  readonly listCoverage: CollectedCalendars["listCoverage"];
  readonly coverage: readonly CoverageEntry[];
  readonly truncations: ReadonlySet<MorningBriefCalendarTruncation>;
}): MorningBriefCalendarCollection["status"] {
  const complete =
    args.listCoverage === "complete" &&
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
        deadlineMs: MORNING_BRIEF_CALENDAR_CAPS.deadlineMs,
      },
      db: args.db,
      clerk: args.clerk,
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

  const { items, listCoverage, state } = access.value;
  if (access.truncatedTotalBytes) {
    state.truncations.add("total-response-bytes");
  }
  const truncations = [...state.truncations].sort();
  const status = collectionStatus({
    itemCount: items.length,
    listCoverage,
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
        ? sourceFailure(listCoverage, state, truncations)
        : null,
  };
}

/** The one reason an unreadable day is attributed to, most specific first. */
function sourceFailure(
  listCoverage: CollectedCalendars["listCoverage"],
  state: CollectionState,
  truncations: readonly MorningBriefCalendarTruncation[],
): MorningBriefCalendarCollection["failure"] {
  if (listCoverage === "denied") {
    return "not-authorized";
  }
  if (state.retryAfterMs !== null) {
    return "rate-limited";
  }
  if (truncations.includes("deadline")) {
    return "deadline-exceeded";
  }
  return "provider-failed";
}
