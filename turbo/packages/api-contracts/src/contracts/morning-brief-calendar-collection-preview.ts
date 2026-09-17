import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { morningBriefSourceFailureSchema } from "./morning-brief-gmail-collection-preview";

const c = initContract();

/**
 * The developer preview of Simple Morning Brief calendar collection.
 *
 * The request carries an anchor and nothing else. The owner, Agent, connector
 * account, timezone and every provider path are derived from the authenticated
 * member's canonical Morning Brief state, never from the caller.
 */

/** Why one readable calendar is not fully represented. */
export const morningBriefCalendarOutcomeSchema = z.enum([
  "complete",
  /** Busy blocks only: `freeBusyReader` never exposes event detail. */
  "free-busy-only",
  /** Endpoint-local denial. Sibling calendars still count as read. */
  "denied",
  "not-found",
  "rate-limited",
  /** Some content was read, but a cap or bad page shortened it. */
  "truncated",
  "failed",
  /** Enumerated and readable, but no request was ever issued for it. */
  "not-read",
]);

export type MorningBriefCalendarOutcome = z.infer<
  typeof morningBriefCalendarOutcomeSchema
>;

/** Every cap that silently shortened a read, reported explicitly. */
export const morningBriefCalendarTruncationSchema = z.enum([
  "calendar-list-pages",
  "calendars",
  "event-pages",
  "events",
  "attendees",
  "total-requests",
  "deadline",
  "total-response-bytes",
  "response-bytes",
  "text-characters",
  "unreadable-event-time",
]);

export type MorningBriefCalendarTruncation = z.infer<
  typeof morningBriefCalendarTruncationSchema
>;

export const morningBriefCalendarAttendeeSchema = z.object({
  label: z.string(),
  responseStatus: z.string().nullable(),
  optional: z.boolean(),
});

export const morningBriefCalendarItemSchema = z.object({
  calendarId: z.string(),
  calendarSummary: z.string().nullable(),
  /** The calendar's own timezone, which may differ from the owner's. */
  calendarTimezone: z.string().nullable(),
  eventId: z.string(),
  iCalUID: z.string().nullable(),
  /** Retained so a recurrence instance stays distinguishable. */
  recurringEventId: z.string().nullable(),
  originalStartTime: z.string().nullable(),
  summary: z.string().nullable(),
  location: z.string().nullable(),
  descriptionExcerpt: z.string().nullable(),
  allDay: z.boolean(),
  /**
   * A timed event carries ISO instants. An all-day event carries calendar
   * dates with an exclusive `end`, never a fabricated UTC midnight.
   */
  start: z.string(),
  end: z.string(),
  eventTimezone: z.string().nullable(),
  /** 0 is today in the owner's timezone; `null` means it starts outside. */
  localDayOffset: z.number().int().min(0).nullable(),
  organizer: z.string().nullable(),
  selfResponseStatus: z.string().nullable(),
  attendees: z.array(morningBriefCalendarAttendeeSchema),
  attendeesTruncated: z.boolean(),
  /** An absolute HTTP(S) display link. It is never followed. */
  link: z.string().nullable(),
});

export type MorningBriefCalendarItem = z.infer<
  typeof morningBriefCalendarItemSchema
>;

export const morningBriefCalendarCoverageEntrySchema = z.object({
  calendarId: z.string(),
  summary: z.string().nullable(),
  accessRole: z.string().nullable(),
  primary: z.boolean(),
  outcome: morningBriefCalendarOutcomeSchema,
  /** Bounded provider metadata. The collector never sleeps or retries on it. */
  retryAfterMs: z.number().int().nonnegative().nullable(),
});

export const morningBriefCalendarCollectionSchema = z.object({
  source: z.literal("google-calendar"),
  /**
   * `ok` and `empty` are complete reads. `partial` kept usable content while
   * losing coverage, and `unavailable` produced none.
   */
  status: z.enum(["ok", "empty", "partial", "unavailable"]),
  anchor: z.string().datetime(),
  collectedAt: z.string().datetime(),
  /** The owner's canonical Morning Brief timezone. */
  timezone: z.string(),
  window: z.object({
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    /** The local day containing the anchor. */
    startDate: z.string(),
    /** The first local day outside the window. */
    endDateExclusive: z.string(),
  }),
  items: z.array(morningBriefCalendarItemSchema),
  coverage: z.object({
    /** Whether the account's calendar list itself could be enumerated. */
    calendarList: z.enum(["complete", "truncated", "denied", "failed"]),
    calendars: z.array(morningBriefCalendarCoverageEntrySchema),
    truncations: z.array(morningBriefCalendarTruncationSchema),
    requests: z.number().int().nonnegative(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
  }),
  failure: morningBriefSourceFailureSchema.nullable(),
});

export type MorningBriefCalendarCollection = z.infer<
  typeof morningBriefCalendarCollectionSchema
>;

export const morningBriefCalendarCollectionPreviewRequestSchema = z.object({
  anchor: z.string().datetime(),
});

export const morningBriefCalendarCollectionPreviewContract = c.router({
  collect: {
    method: "POST",
    path: "/api/morning-brief/preview/calendar-collection",
    headers: authHeadersSchema,
    body: morningBriefCalendarCollectionPreviewRequestSchema,
    responses: {
      200: morningBriefCalendarCollectionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: z.string(),
      // The source's single absolute deadline expired inside the preflight that
      // admits it, before an installation and timezone were resolved.
      504: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Collect calendars for Simple Morning Brief in a developer preview",
  },
});

export type MorningBriefCalendarCollectionPreviewContract =
  typeof morningBriefCalendarCollectionPreviewContract;
