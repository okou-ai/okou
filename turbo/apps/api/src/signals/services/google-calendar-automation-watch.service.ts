import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  type GoogleCalendarWatchActionRequiredReason,
} from "@okouai/api-contracts/contracts/workflows";
import {
  googleCalendarEventSnapshots,
  googleCalendarWatchStates,
} from "@okouai/db/schema/google-calendar-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { webUrl } from "../../lib/web-url";
import { writeDb$ } from "../external/db";
import { onRejection, tapError } from "../utils";
import {
  builtinConnectorCredentialRuntimeValueRef,
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
} from "./builtin-connector-credential-runtime.service";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import {
  GOOGLE_CALENDAR_EVENT_TYPES,
  GOOGLE_CALENDAR_PRIMARY_ID,
  googleCalendarAccountProjectionStatement,
} from "./google-calendar-automation-account.service";
import { loadConnectorRuntimeAuthSelection } from "./connector-catalog-slug-source.service";

const log = logger("api:google-calendar-automation-event");

const GOOGLE_CALENDAR_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_CALENDAR_TOKEN";

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

const WATCH_TTL_SECONDS = 7 * 24 * 60 * 60;

const WATCH_LIFECYCLE_TIMEOUT_MS = 30 * 1000;

const CALENDAR_EVENTS_PAGE_SIZE = 2500;

interface GoogleCalendarAccess {
  readonly connectorId: string;
  readonly emailAddress: string | null;
  readonly accessToken: string;
}

type GoogleCalendarAccessResult =
  | {
      readonly kind: "ok";
      readonly access: GoogleCalendarAccess;
    }
  | {
      readonly kind: "bad_request";
      readonly message: string;
    };

interface GoogleCalendarProviderFailure {
  readonly stage: "watch_registration" | "baseline";
  readonly status: number;
  readonly reason: string;
}

export type EnsureGoogleCalendarWatchResult =
  | {
      readonly kind: "ok";
    }
  | {
      readonly kind: "bad_request";
      readonly message: string;
      readonly providerFailure?: GoogleCalendarProviderFailure;
    };

type GoogleCalendarWatchReconcileResult =
  | {
      readonly kind: "unchanged";
    }
  | {
      readonly kind: "renewed";
    }
  | {
      readonly kind: "stopped";
    }
  | {
      readonly kind: "failed";
    };

type GoogleCalendarWatchTargetType =
  "primary" | "explicit_calendar" | "verified_legacy_primary_alias";

interface GoogleCalendarWatchActionRequiredEpisode {
  readonly reason: GoogleCalendarWatchActionRequiredReason;
  readonly startedAt: Date;
}

interface GoogleCalendarFetchOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface GoogleCalendarFetchError {
  readonly kind: "error";
  readonly status: number;
  readonly message: string;
}

type GoogleCalendarFetchResult<T> =
  GoogleCalendarFetchOk<T> | GoogleCalendarFetchError;

const calendarWatchResponseSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  resourceUri: z.string(),
  expiration: z.union([z.string(), z.number()]).optional(),
});

const calendarResourceSchema = z.object({ id: z.string() });

const calendarEventDateTimeSchema = z
  .object({
    date: z.string().optional(),
    dateTime: z.string().optional(),
    timeZone: z.string().optional(),
  })
  .passthrough();

const calendarEventPersonSchema = z
  .object({
    email: z.string().optional(),
    displayName: z.string().optional(),
    self: z.boolean().optional(),
  })
  .passthrough();

export const calendarEventAttendeeSchema = calendarEventPersonSchema.extend({
  responseStatus: z.string().optional(),
});

const calendarEventSchema = z
  .object({
    id: z.string(),
    etag: z.string().optional(),
    status: z.string().optional(),
    htmlLink: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    eventType: z.string().optional(),
    start: calendarEventDateTimeSchema.optional(),
    end: calendarEventDateTimeSchema.optional(),
    organizer: calendarEventPersonSchema.optional(),
    creator: calendarEventPersonSchema.optional(),
    attendees: z.array(calendarEventAttendeeSchema).optional(),
    recurringEventId: z.string().optional(),
    originalStartTime: calendarEventDateTimeSchema.optional(),
  })
  .passthrough();

const calendarEventsListResponseSchema = z.object({
  items: z.array(calendarEventSchema).optional(),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
});

export type GoogleCalendarEvent = z.infer<typeof calendarEventSchema>;

export type GoogleCalendarWatchStateRow =
  typeof googleCalendarWatchStates.$inferSelect;

export interface GoogleCalendarChannelIdentity {
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
}

function tokenNeedsRefresh(
  tokenExpiresAt: Date | null,
  currentTime: Date,
): boolean {
  if (tokenExpiresAt === null) {
    return true;
  }
  return (
    tokenExpiresAt.getTime() <= currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

export const resolveGoogleCalendarAccess$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly refreshExpiredToken?: boolean;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarAccessResult> => {
    const currentTime = nowDate();
    const snapshot = await loadConnectorRuntimeAuthSelection(set(writeDb$), {
      connectorSlugs: ["google-calendar"],
    });
    signal.throwIfAborted();
    const loaded = await set(loadBuiltinConnectorCredentialConnection$, {
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: "google-calendar",
      connectorId: args.connectorId,
    });
    signal.throwIfAborted();
    if (loaded.kind === "missing") {
      return {
        kind: "bad_request",
        message:
          "Connect Google Calendar before adding a Google Calendar event automation",
      };
    }
    if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Calendar before using Google Calendar event automations",
      };
    }
    const connection = loaded.connection;
    const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
      connection,
      GOOGLE_CALENDAR_ACCESS_TOKEN_ENVIRONMENT_NAME,
    );
    if (accessTokenValueRef === null) {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Calendar before using Google Calendar event automations",
      };
    }

    const values = await set(
      loadBuiltinConnectorCredentialValues$,
      { connection, valueRefs: [accessTokenValueRef] },
      signal,
    );
    signal.throwIfAborted();
    const accessToken = values.get(accessTokenValueRef);
    if (!accessToken) {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Calendar before using Google Calendar event automations",
      };
    }
    if (
      !tokenNeedsRefresh(connection.tokenExpiresAt, currentTime) ||
      args.refreshExpiredToken === false
    ) {
      return {
        kind: "ok",
        access: {
          connectorId: connection.connectorId,
          emailAddress: connection.externalEmail,
          accessToken,
        },
      };
    }
    const refreshed = await set(
      refreshBuiltinConnectorCredentialAccess$,
      {
        connection,
        orgId: args.orgId,
        userId: args.userId,
        runtimeEnvironmentName: GOOGLE_CALENDAR_ACCESS_TOKEN_ENVIRONMENT_NAME,
        persist: { markNeedsReconnectOnFailure: true },
      },
      signal,
    );
    if (refreshed.kind === "configuration-unavailable") {
      return {
        kind: "bad_request",
        message: "Google OAuth client env vars are not configured",
      };
    }
    if (refreshed.kind !== "ok") {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Calendar before using Google Calendar event automations",
      };
    }
    return {
      kind: "ok",
      access: {
        connectorId: connection.connectorId,
        emailAddress: connection.externalEmail,
        accessToken: refreshed.accessToken,
      },
    };
  },
);

function calendarApiUrl(path: string): string {
  return `${GOOGLE_CALENDAR_API_BASE}${path}`;
}

function calendarEventsUrl(calendarId: string): string {
  return calendarApiUrl(`/calendars/${encodeURIComponent(calendarId)}/events`);
}

function googleCalendarWebhookUrl(): string {
  const baseUrl = apiBackendUrl() ?? webUrl();
  return new URL("/api/webhooks/google-calendar", baseUrl).toString();
}

function googleCalendarProviderReason(status: number): string {
  if (status === 0) {
    return "request_failed";
  }
  if (status === 400) {
    return "invalid_request";
  }
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "provider_unavailable";
  }
  return "provider_error";
}

function calendarWatchProviderFailure(
  status: number,
): GoogleCalendarProviderFailure {
  return {
    stage: "watch_registration",
    status,
    reason: googleCalendarProviderReason(status),
  };
}

function logCalendarWatchProviderFailure(
  action: "ensure" | "renew",
  failure: GoogleCalendarProviderFailure,
): void {
  log.warn("Workflow watch lifecycle reconciliation failed", {
    provider: "google_calendar",
    action,
    result: "provider_error",
    stage: failure.stage,
    status: failure.status,
    reason: failure.reason,
  });
}

async function googleCalendarFetchJson<T>(
  schema: z.ZodType<T>,
  accessToken: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<GoogleCalendarFetchResult<T>> {
  const response = await tapError(
    fetch(url, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    }),
  );
  signal.throwIfAborted();
  if (!response) {
    return {
      kind: "error",
      status: 0,
      message: "Google Calendar request failed",
    };
  }

  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: await response.text(),
    };
  }

  return { kind: "ok", value: schema.parse(await response.json()) };
}

async function googleCalendarFetchNoContent(
  args: {
    readonly accessToken: string;
    readonly url: string;
    readonly init: RequestInit;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarFetchResult<null>> {
  const response = await tapError(
    fetch(args.url, {
      ...args.init,
      signal,
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
        ...args.init.headers,
      },
    }),
  );
  signal.throwIfAborted();
  if (!response) {
    return {
      kind: "error",
      status: 0,
      message: "Google Calendar request failed",
    };
  }
  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: await response.text(),
    };
  }
  return { kind: "ok", value: null };
}

function mintChannelToken(): string {
  return randomBytes(32).toString("base64url");
}

function watchExpirationDate(
  expiration: string | number | undefined,
  currentTime: Date,
): Date {
  const millis = expiration === undefined ? Number.NaN : Number(expiration);
  if (Number.isFinite(millis)) {
    return new Date(millis);
  }
  return new Date(currentTime.getTime() + WATCH_TTL_SECONDS * 1000);
}

async function watchCalendarEvents(
  args: {
    readonly accessToken: string;
    readonly calendarId: string;
    readonly channelId: string;
    readonly channelToken: string;
  },
  signal: AbortSignal,
): Promise<
  GoogleCalendarFetchResult<z.infer<typeof calendarWatchResponseSchema>>
> {
  return await googleCalendarFetchJson(
    calendarWatchResponseSchema,
    args.accessToken,
    `${calendarEventsUrl(args.calendarId)}/watch`,
    {
      method: "POST",
      body: JSON.stringify({
        id: args.channelId,
        type: "web_hook",
        address: googleCalendarWebhookUrl(),
        token: args.channelToken,
        params: { ttl: String(WATCH_TTL_SECONDS) },
      }),
    },
    signal,
  );
}

async function probeExactCalendarTarget(
  args: {
    readonly accessToken: string;
    readonly calendarId: string;
  },
  signal: AbortSignal,
): Promise<"readable" | "missing" | "retryable"> {
  const result = await googleCalendarFetchJson(
    calendarResourceSchema,
    args.accessToken,
    calendarApiUrl(`/calendars/${encodeURIComponent(args.calendarId)}`),
    { method: "GET" },
    signal,
  );
  signal.throwIfAborted();
  return result.kind === "ok"
    ? "readable"
    : result.status === 404
      ? "missing"
      : "retryable";
}

async function stopCalendarChannel(
  args: {
    readonly accessToken: string;
    readonly channelId: string;
    readonly resourceId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const result = await googleCalendarFetchNoContent(
    {
      accessToken: args.accessToken,
      url: calendarApiUrl("/channels/stop"),
      init: {
        method: "POST",
        body: JSON.stringify({
          id: args.channelId,
          resourceId: args.resourceId,
        }),
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind !== "ok") {
    if (result.status === 404) {
      return true;
    }
    log.warn("Failed to stop Google Calendar watch channel", {
      provider: "google_calendar",
      action: "stop",
      result: "provider_error",
      status: result.status,
    });
    return false;
  }
  return true;
}

export async function stopCalendarChannelWithLifecycleOwnership(args: {
  readonly accessToken: string;
  readonly channel: GoogleCalendarChannelIdentity;
}): Promise<boolean> {
  const stopped = await tapError(
    stopCalendarChannel(
      {
        accessToken: args.accessToken,
        channelId: args.channel.channelId,
        resourceId: args.channel.resourceId,
      },
      AbortSignal.timeout(WATCH_LIFECYCLE_TIMEOUT_MS),
    ),
    (error) => {
      log.warn("Failed to finish Google Calendar watch channel cleanup", {
        provider: "google_calendar",
        action: "stop",
        result: "cleanup_error",
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
  return stopped ?? false;
}

type CalendarEventsListResult =
  | {
      readonly kind: "ok";
      readonly events: readonly GoogleCalendarEvent[];
      readonly nextSyncToken: string;
    }
  | {
      readonly kind: "stale_cursor";
    }
  | {
      readonly kind: "calendar_error";
      readonly message: string;
      readonly status: number;
    };

export type CalendarEventsListOk = Extract<
  CalendarEventsListResult,
  {
    readonly kind: "ok";
  }
>;

export async function listCalendarEvents(
  args: {
    readonly accessToken: string;
    readonly calendarId: string;
    readonly syncToken?: string | null;
  },
  signal: AbortSignal,
): Promise<CalendarEventsListResult> {
  let pageToken: string | null = null;
  const events: GoogleCalendarEvent[] = [];
  let nextSyncToken: string | null = null;

  do {
    const url = new URL(calendarEventsUrl(args.calendarId));
    url.searchParams.set("maxResults", String(CALENDAR_EVENTS_PAGE_SIZE));
    url.searchParams.set("showDeleted", "true");
    if (args.syncToken) {
      url.searchParams.set("syncToken", args.syncToken);
    }
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const result = await googleCalendarFetchJson(
      calendarEventsListResponseSchema,
      args.accessToken,
      url.toString(),
      { method: "GET" },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return result.status === 410
        ? { kind: "stale_cursor" }
        : {
            kind: "calendar_error",
            message: result.message,
            status: result.status,
          };
    }

    events.push(...(result.value.items ?? []));
    pageToken = result.value.nextPageToken ?? null;
    nextSyncToken = result.value.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  if (!nextSyncToken) {
    return {
      kind: "calendar_error",
      message: "Google Calendar did not return a nextSyncToken",
      status: 0,
    };
  }

  return { kind: "ok", events, nextSyncToken };
}

export function parseGoogleDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventStartDate(event: GoogleCalendarEvent): Date | null {
  return parseGoogleDate(event.start?.dateTime ?? event.start?.date);
}

function eventEndDate(event: GoogleCalendarEvent): Date | null {
  return parseGoogleDate(event.end?.dateTime ?? event.end?.date);
}

export function eventSnapshotValue(
  event: GoogleCalendarEvent,
): Record<string, unknown> {
  return structuredClone({
    id: event.id,
    etag: event.etag,
    status: event.status,
    eventType: event.eventType,
    summary: event.summary,
    htmlLink: event.htmlLink,
    start: event.start,
    end: event.end,
    organizer: event.organizer,
    attendees: event.attendees,
    created: event.created,
    updated: event.updated,
    recurringEventId: event.recurringEventId,
    originalStartTime: event.originalStartTime,
  }) as Record<string, unknown>;
}

function eventSnapshotRow(args: {
  readonly watchStateId: string;
  readonly event: GoogleCalendarEvent;
  readonly currentTime: Date;
}) {
  return {
    watchStateId: args.watchStateId,
    calendarEventId: args.event.id,
    etag: args.event.etag ?? null,
    status: args.event.status ?? null,
    eventType: args.event.eventType ?? null,
    summary: args.event.summary ?? null,
    startAt: eventStartDate(args.event),
    endAt: eventEndDate(args.event),
    eventCreatedAt: parseGoogleDate(args.event.created),
    eventUpdatedAt: parseGoogleDate(args.event.updated),
    snapshot: eventSnapshotValue(args.event),
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

const CALENDAR_SNAPSHOT_BATCH_SIZE = 250;

interface CalendarSnapshotBatch {
  readonly watchStateId: string;
  readonly events: readonly GoogleCalendarEvent[];
  readonly currentTime: Date;
}

const upsertCalendarEventSnapshotBatch$ = command(
  async (
    { set },
    args: CalendarSnapshotBatch,
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.events.length === 0) {
      return;
    }
    if (args.events.length > CALENDAR_SNAPSHOT_BATCH_SIZE) {
      throw new Error("Calendar snapshot batch is too large");
    }
    await set(writeDb$)
      .insert(googleCalendarEventSnapshots)
      .values(
        args.events.map((event) => {
          return eventSnapshotRow({
            watchStateId: args.watchStateId,
            event,
            currentTime: args.currentTime,
          });
        }),
      )
      .onConflictDoUpdate({
        target: [
          googleCalendarEventSnapshots.watchStateId,
          googleCalendarEventSnapshots.calendarEventId,
        ],
        set: {
          etag: sql`excluded.etag`,
          status: sql`excluded.status`,
          eventType: sql`excluded.event_type`,
          summary: sql`excluded.summary`,
          startAt: sql`excluded.start_at`,
          endAt: sql`excluded.end_at`,
          eventCreatedAt: sql`excluded.event_created_at`,
          eventUpdatedAt: sql`excluded.event_updated_at`,
          snapshot: sql`excluded.snapshot`,
          updatedAt: args.currentTime,
        },
      });
    signal.throwIfAborted();
  },
);

export const upsertCalendarEventSnapshots$ = command(
  async (
    { set },
    args: CalendarSnapshotBatch,
    signal: AbortSignal,
  ): Promise<void> => {
    for (
      let offset = 0;
      offset < args.events.length;
      offset += CALENDAR_SNAPSHOT_BATCH_SIZE
    ) {
      await set(
        upsertCalendarEventSnapshotBatch$,
        {
          ...args,
          events: args.events.slice(
            offset,
            offset + CALENDAR_SNAPSHOT_BATCH_SIZE,
          ),
        },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);

const publishCalendarBaselineCursor$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly syncToken: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(googleCalendarWatchStates)
      .set({
        syncToken: args.syncToken,
        needsRewatch: false,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(googleCalendarWatchStates.id, args.state.id),
          isNull(googleCalendarWatchStates.actionRequiredReason),
        ),
      );
    signal.throwIfAborted();
  },
);

const loadCalendarWatchState$ = command(
  async (
    { set },
    args: {
      readonly connectorId: string;
      readonly calendarId: string;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchStateRow | null> => {
    const db = set(writeDb$);
    const [state] = await db
      .select()
      .from(googleCalendarWatchStates)
      .where(
        and(
          eq(googleCalendarWatchStates.connectorId, args.connectorId),
          eq(googleCalendarWatchStates.calendarId, args.calendarId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return state ?? null;
  },
);

function watchNeedsRefresh(
  state: Pick<
    GoogleCalendarWatchStateRow,
    "needsRewatch" | "syncToken" | "watchExpirationAt" | "actionRequiredReason"
  >,
  currentTime: Date,
): boolean {
  return (
    state.actionRequiredReason !== null ||
    state.needsRewatch ||
    state.syncToken === null ||
    state.watchExpirationAt.getTime() <=
      currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS
  );
}

export function calendarWatchActionRequiredEpisode(
  state: Pick<
    GoogleCalendarWatchStateRow,
    "actionRequiredReason" | "actionRequiredAt"
  >,
): GoogleCalendarWatchActionRequiredEpisode | null {
  if (
    (state.actionRequiredReason === null) !==
    (state.actionRequiredAt === null)
  ) {
    throw new Error("Incomplete Google Calendar action-required episode");
  }
  return state.actionRequiredReason === null
    ? null
    : {
        reason: state.actionRequiredReason,
        startedAt: state.actionRequiredAt!,
      };
}

export function googleCalendarWatchTargetType(
  calendarId: string,
): GoogleCalendarWatchTargetType {
  return calendarId === GOOGLE_CALENDAR_PRIMARY_ID
    ? "primary"
    : "explicit_calendar";
}

function logCalendarWatchActionRequiredRecovery(args: {
  readonly watchStateId: string;
  readonly episode: GoogleCalendarWatchActionRequiredEpisode;
  readonly targetType: GoogleCalendarWatchTargetType;
}): void {
  log.debug("Workflow watch action-required episode recovered", {
    provider: "google_calendar",
    action: "recover",
    result: "ok",
    reason: args.episode.reason,
    watchStateId: args.watchStateId,
    episodeStartedAt: args.episode.startedAt.toISOString(),
    targetType: args.targetType,
  });
}

export const hasEnabledGoogleCalendarConsumer$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly calendarId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const automations = await db
      .select({
        eventType: workflowAutomations.eventType,
        eventConfig: workflowAutomations.eventConfig,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          eq(workflowAutomations.eventConnectorId, args.connectorId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          inArray(workflowAutomations.eventType, [
            ...GOOGLE_CALENDAR_EVENT_TYPES,
          ]),
        ),
      );
    signal.throwIfAborted();
    return automations.some((automation) => {
      return (
        parseGoogleCalendarEventAutomationConfig(automation)?.calendarId ===
        args.calendarId
      );
    });
  },
);

const transitionCalendarWatchToActionRequired$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
      readonly reason: GoogleCalendarWatchActionRequiredReason;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    await db
      .update(googleCalendarWatchStates)
      .set({
        actionRequiredReason: args.reason,
        actionRequiredAt: currentTime,
        needsRewatch: true,
        updatedAt: currentTime,
      })
      .where(eq(googleCalendarWatchStates.id, args.state.id));
    signal.throwIfAborted();
  },
);

interface EnsureGoogleCalendarWatchArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly calendarId?: string;
  readonly forceRefresh?: boolean;
  /**
   * Routine renewal: replace the channel even when it is not yet inside the
   * default renewal window, but keep the sync baseline (token and snapshots)
   * unless the watch state itself requires a new one.
   */
  readonly renewal?: boolean;
  readonly reportProviderFailure?: boolean;
}

/**
 * A watch only re-lists its baseline when it is new, explicitly forced, has no
 * sync token or needs user action. A routine channel renewal keeps the sync
 * token and snapshots so changes since the last sync are still delivered and
 * existing events are not reclassified as created.
 */
function calendarWatchNeedsNewBaseline(
  observed: GoogleCalendarWatchStateRow | null,
  args: Pick<EnsureGoogleCalendarWatchArgs, "forceRefresh" | "renewal">,
): boolean {
  return (
    observed === null ||
    (args.forceRefresh === true && args.renewal !== true) ||
    observed.syncToken === null ||
    observed.actionRequiredReason !== null
  );
}

export interface StagedGoogleCalendarWatchTarget {
  readonly connectorId: string;
  readonly calendarId: string;
}

type StageGoogleCalendarWatchTargetResult =
  | {
      readonly kind: "ok";
      readonly stagedTarget: StagedGoogleCalendarWatchTarget;
    }
  | Exclude<
      EnsureGoogleCalendarWatchResult,
      {
        readonly kind: "ok";
      }
    >;

interface CalendarAutomationTarget {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly calendarId: string;
}

/** Every owned event automation on the target, enabled or not. */
function calendarAutomationTargetCondition(args: CalendarAutomationTarget) {
  return and(
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.eventConnectorId, args.connectorId),
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [...GOOGLE_CALENDAR_EVENT_TYPES]),
    eq(sql`${workflowAutomations.eventConfig}->>'calendarId'`, args.calendarId),
  );
}

const publishGoogleCalendarWatch$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly calendarId: string;
      readonly channelId: string;
      readonly channelToken: string;
      readonly watch: z.infer<typeof calendarWatchResponseSchema>;
      readonly resetBaseline: boolean;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchStateRow> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const baselineReset = args.resetBaseline
      ? {
          previousChannelId: null,
          previousChannelToken: null,
          previousResourceId: null,
          syncToken: null,
        }
      : {};
    const watchState = {
      orgId: args.orgId,
      userId: args.userId,
      channelId: args.channelId,
      channelToken: args.channelToken,
      resourceId: args.watch.resourceId,
      resourceUri: args.watch.resourceUri,
      ...baselineReset,
      watchExpirationAt: watchExpirationDate(
        args.watch.expiration,
        currentTime,
      ),
      lastWatchRenewedAt: currentTime,
      needsRewatch: false,
      actionRequiredReason: null,
      actionRequiredAt: null,
      updatedAt: currentTime,
    };
    return await db.transaction(async (tx) => {
      const [state] = await tx
        .insert(googleCalendarWatchStates)
        .values({
          ...watchState,
          connectorId: args.connectorId,
          calendarId: args.calendarId,
          createdAt: currentTime,
        })
        .onConflictDoUpdate({
          target: [
            googleCalendarWatchStates.connectorId,
            googleCalendarWatchStates.calendarId,
          ],
          set: watchState,
        })
        .returning();
      if (!state) {
        throw new Error("Failed to persist Google Calendar watch state");
      }
      if (args.resetBaseline) {
        await tx
          .delete(googleCalendarEventSnapshots)
          .where(eq(googleCalendarEventSnapshots.watchStateId, state.id));
      }
      signal.throwIfAborted();
      return state;
    });
  },
);

const cleanupUnpublishedCalendarWatch$ = command(
  async (
    { set },
    args: {
      readonly accessToken: string;
      readonly channel: GoogleCalendarChannelIdentity;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
    // A commit error is not proof that publication failed. Read authority first;
    // failed reads leave the unreferenced channel to expire.
    const [published] = await db
      .select({ id: googleCalendarWatchStates.id })
      .from(googleCalendarWatchStates)
      .where(eq(googleCalendarWatchStates.channelId, args.channel.channelId))
      .limit(1);
    if (!published) {
      await stopCalendarChannelWithLifecycleOwnership(args);
    }
  },
);

async function prepareCalendarWatchCandidate(
  args: {
    readonly accessToken: string;
    readonly calendarId: string;
    readonly resetBaseline: boolean;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "ok";
      readonly baseline: CalendarEventsListOk | null;
      readonly watch: z.infer<typeof calendarWatchResponseSchema>;
      readonly channelId: string;
      readonly channelToken: string;
    }
  | Exclude<EnsureGoogleCalendarWatchResult, { readonly kind: "ok" }>
> {
  const target = { accessToken: args.accessToken, calendarId: args.calendarId };
  const baseline = args.resetBaseline
    ? await listCalendarEvents({ ...target, syncToken: null }, signal)
    : null;
  signal.throwIfAborted();
  if (baseline !== null && baseline.kind !== "ok") {
    return {
      kind: "bad_request",
      message: "Failed to establish Google Calendar event automation baseline",
      ...(baseline.kind === "calendar_error"
        ? {
            providerFailure: {
              stage: "baseline" as const,
              status: baseline.status,
              reason: googleCalendarProviderReason(baseline.status),
            },
          }
        : {}),
    };
  }

  const channelId = randomUUID();
  const channelToken = mintChannelToken();
  const watch = await watchCalendarEvents(
    { ...target, channelId, channelToken },
    signal,
  );
  signal.throwIfAborted();
  if (watch.kind !== "ok") {
    return {
      kind: "bad_request",
      message:
        "Failed to register Google Calendar watch for event automation setup",
      providerFailure: calendarWatchProviderFailure(watch.status),
    };
  }
  return { kind: "ok", baseline, channelId, channelToken, watch: watch.value };
}

const ensureGoogleCalendarWatchForUserInternal$ = command(
  async (
    { set },
    args: EnsureGoogleCalendarWatchArgs & {
      readonly allowStagedTarget?: boolean;
    },
    signal: AbortSignal,
  ): Promise<EnsureGoogleCalendarWatchResult> => {
    const calendarId = args.calendarId ?? GOOGLE_CALENDAR_PRIMARY_ID;
    const accessResult = await set(resolveGoogleCalendarAccess$, args, signal);
    if (accessResult.kind !== "ok") {
      return accessResult;
    }

    if (
      !args.allowStagedTarget &&
      !(await set(
        hasEnabledGoogleCalendarConsumer$,
        { ...args, calendarId },
        signal,
      ))
    ) {
      return { kind: "ok" };
    }
    const observed = await set(
      loadCalendarWatchState$,
      { connectorId: args.connectorId, calendarId },
      signal,
    );
    if (
      observed &&
      !args.forceRefresh &&
      !watchNeedsRefresh(observed, nowDate())
    ) {
      return { kind: "ok" };
    }
    const resetBaseline = calendarWatchNeedsNewBaseline(observed, args);
    const candidate = await prepareCalendarWatchCandidate(
      {
        accessToken: accessResult.access.accessToken,
        calendarId,
        resetBaseline,
      },
      signal,
    );
    signal.throwIfAborted();
    if (candidate.kind !== "ok") {
      if (candidate.providerFailure && args.reportProviderFailure !== false) {
        logCalendarWatchProviderFailure("ensure", candidate.providerFailure);
      }
      return candidate;
    }
    const { baseline, channelId, channelToken, watch } = candidate;
    const cleanup = {
      accessToken: accessResult.access.accessToken,
      channel: { channelId, channelToken, resourceId: watch.resourceId },
    };
    const state = await onRejection(
      set(
        publishGoogleCalendarWatch$,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorId: accessResult.access.connectorId,
          calendarId,
          channelId,
          channelToken,
          watch,
          resetBaseline: baseline !== null,
        },
        signal,
      ),
      async () => {
        await set(cleanupUnpublishedCalendarWatch$, cleanup);
      },
    );
    signal.throwIfAborted();
    if (baseline !== null) {
      await set(
        upsertCalendarEventSnapshots$,
        {
          watchStateId: state.id,
          events: baseline.events,
          currentTime: nowDate(),
        },
        signal,
      );
      signal.throwIfAborted();
      await set(
        publishCalendarBaselineCursor$,
        { state, syncToken: baseline.nextSyncToken },
        signal,
      );
      signal.throwIfAborted();
    }
    if (observed) {
      const episode = calendarWatchActionRequiredEpisode(observed);
      if (episode) {
        logCalendarWatchActionRequiredRecovery({
          watchStateId: state.id,
          episode,
          targetType: googleCalendarWatchTargetType(calendarId),
        });
      }
      if (observed.resourceId) {
        await stopCalendarChannelWithLifecycleOwnership({
          accessToken: accessResult.access.accessToken,
          channel: observed,
        });
      }
    }
    return { kind: "ok" };
  },
);

export const ensureGoogleCalendarWatchForUser$ = command(
  async (
    { set },
    args: EnsureGoogleCalendarWatchArgs,
    signal: AbortSignal,
  ): Promise<EnsureGoogleCalendarWatchResult> => {
    return await set(ensureGoogleCalendarWatchForUserInternal$, args, signal);
  },
);

export const stageGoogleCalendarWatchTargetForReconfiguration$ = command(
  async (
    { set },
    args: EnsureGoogleCalendarWatchArgs & {
      readonly calendarId: string;
    },
    signal: AbortSignal,
  ): Promise<StageGoogleCalendarWatchTargetResult> => {
    const result = await set(
      ensureGoogleCalendarWatchForUserInternal$,
      { ...args, allowStagedTarget: true },
      signal,
    );
    return result.kind === "ok"
      ? {
          kind: "ok",
          stagedTarget: {
            connectorId: args.connectorId,
            calendarId: args.calendarId,
          },
        }
      : result;
  },
);

interface LegacyPrimaryCalendarMigrationArgs {
  readonly access: GoogleCalendarAccess;
  readonly legacyCalendarId: string;
  readonly orgId: string;
  readonly userId: string;
}

const persistLegacyPrimaryCalendarMigration$ = command(
  async (
    { set },
    args: LegacyPrimaryCalendarMigrationArgs,
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchStateRow | null> => {
    const db = set(writeDb$);
    // A disabled automation must not keep the dead alias either: re-enabling
    // it would target a calendar ID that no longer resolves.
    const legacyTargetCondition = calendarAutomationTargetCondition({
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.access.connectorId,
      calendarId: args.legacyCalendarId,
    });
    return await db.transaction(async (tx) => {
      const states = await tx
        .select()
        .from(googleCalendarWatchStates)
        .where(
          and(
            eq(googleCalendarWatchStates.connectorId, args.access.connectorId),
            inArray(googleCalendarWatchStates.calendarId, [
              args.legacyCalendarId,
              GOOGLE_CALENDAR_PRIMARY_ID,
            ]),
            eq(googleCalendarWatchStates.orgId, args.orgId),
            eq(googleCalendarWatchStates.userId, args.userId),
          ),
        );
      const legacy = states.find((state) => {
        return state.calendarId === args.legacyCalendarId;
      });
      const primary = states.find((state) => {
        return state.calendarId === GOOGLE_CALENDAR_PRIMARY_ID;
      });
      const currentTime = nowDate();
      // The opaque provider resource identity proves the unavailable alias was
      // this primary calendar; an arbitrary shared calendar must not be rebound.
      if (
        !legacy ||
        !primary ||
        !legacy.resourceId ||
        legacy.resourceId !== primary.resourceId ||
        primary.syncToken === null ||
        primary.needsRewatch ||
        primary.actionRequiredReason !== null ||
        primary.watchExpirationAt <= currentTime
      ) {
        return null;
      }
      await tx
        .update(workflowAutomations)
        .set({
          eventConfig: sql`jsonb_set(${workflowAutomations.eventConfig}, '{calendarId}', to_jsonb(${GOOGLE_CALENDAR_PRIMARY_ID}::text))`,
          updatedAt: currentTime,
        })
        .where(legacyTargetCondition);
      const [removed] = await tx
        .delete(googleCalendarWatchStates)
        .where(eq(googleCalendarWatchStates.id, legacy.id))
        .returning();
      signal.throwIfAborted();
      return removed ?? null;
    });
  },
);

const migrateLegacyPrimaryCalendarWatch$ = command(
  async (
    { set },
    args: LegacyPrimaryCalendarMigrationArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const ensured = await set(
      stageGoogleCalendarWatchTargetForReconfiguration$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.access.connectorId,
        calendarId: GOOGLE_CALENDAR_PRIMARY_ID,
        forceRefresh: true,
        reportProviderFailure: false,
      },
      signal,
    );
    signal.throwIfAborted();
    if (ensured.kind !== "ok") {
      return false;
    }
    const migratedState = await set(
      persistLegacyPrimaryCalendarMigration$,
      args,
      signal,
    );
    if (!migratedState) {
      await set(
        reconcileGoogleCalendarWatchState$,
        {
          connectorId: args.access.connectorId,
          calendarId: GOOGLE_CALENDAR_PRIMARY_ID,
        },
        signal,
      );
      return false;
    }
    await stopCalendarChannelWithLifecycleOwnership({
      accessToken: args.access.accessToken,
      channel: migratedState,
    });
    signal.throwIfAborted();
    return true;
  },
);

const deleteInactiveCalendarWatch$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleCalendarWatchStateRow;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [deleted] = await db
      .delete(googleCalendarWatchStates)
      .where(eq(googleCalendarWatchStates.id, args.state.id))
      .returning({ id: googleCalendarWatchStates.id });
    signal.throwIfAborted();
    return deleted !== undefined;
  },
);

function logCalendarWatchActionRequiredRetry(args: {
  readonly state: GoogleCalendarWatchStateRow;
  readonly episode: GoogleCalendarWatchActionRequiredEpisode;
  readonly result: "provider_error" | "target_missing";
}): void {
  log.debug("Workflow watch action-required retry did not recover", {
    provider: "google_calendar",
    action: "renew",
    result: args.result,
    reason: args.episode.reason,
    watchStateId: args.state.id,
    episodeStartedAt: args.episode.startedAt.toISOString(),
    targetType: googleCalendarWatchTargetType(args.state.calendarId),
  });
}

const reconcileActionRequiredNonPrimaryCalendarWatch$ = command(
  async (
    { set },
    args: {
      readonly access: GoogleCalendarAccess;
      readonly state: GoogleCalendarWatchStateRow;
      readonly episode: GoogleCalendarWatchActionRequiredEpisode;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchReconcileResult> => {
    const exactTarget = await probeExactCalendarTarget(
      {
        accessToken: args.access.accessToken,
        calendarId: args.state.calendarId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (exactTarget === "readable") {
      const ensured = await set(
        ensureGoogleCalendarWatchForUser$,
        {
          orgId: args.state.orgId,
          userId: args.state.userId,
          connectorId: args.state.connectorId,
          calendarId: args.state.calendarId,
          forceRefresh: true,
          reportProviderFailure: false,
        },
        signal,
      );
      if (ensured.kind === "ok") {
        return { kind: "renewed" };
      }
      logCalendarWatchActionRequiredRetry({
        state: args.state,
        episode: args.episode,
        result: "provider_error",
      });
      return { kind: "failed" };
    }
    if (exactTarget === "retryable") {
      logCalendarWatchActionRequiredRetry({
        state: args.state,
        episode: args.episode,
        result: "provider_error",
      });
      return { kind: "failed" };
    }
    const migrated = await set(
      migrateLegacyPrimaryCalendarWatch$,
      {
        access: args.access,
        legacyCalendarId: args.state.calendarId,
        orgId: args.state.orgId,
        userId: args.state.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (migrated) {
      logCalendarWatchActionRequiredRecovery({
        watchStateId: args.state.id,
        episode: args.episode,
        targetType: "verified_legacy_primary_alias",
      });
      return { kind: "renewed" };
    }
    await set(
      transitionCalendarWatchToActionRequired$,
      { state: args.state, reason: "calendar_not_found" },
      signal,
    );
    logCalendarWatchActionRequiredRetry({
      state: args.state,
      episode: args.episode,
      result: "target_missing",
    });
    return { kind: "failed" };
  },
);

const reconcileConfirmedMissingCalendarWatch$ = command(
  async (
    { set },
    args: {
      readonly access: GoogleCalendarAccess;
      readonly state: GoogleCalendarWatchStateRow;
      readonly providerFailure: GoogleCalendarProviderFailure;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchReconcileResult> => {
    if (args.state.calendarId !== GOOGLE_CALENDAR_PRIMARY_ID) {
      const migrated = await set(
        migrateLegacyPrimaryCalendarWatch$,
        {
          access: args.access,
          legacyCalendarId: args.state.calendarId,
          orgId: args.state.orgId,
          userId: args.state.userId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (migrated) {
        log.debug("Workflow watch legacy primary alias recovered", {
          provider: "google_calendar",
          action: "migrate_primary",
          result: "ok",
          stage: args.providerFailure.stage,
          status: args.providerFailure.status,
          reason: args.providerFailure.reason,
          watchStateId: args.state.id,
          targetType: "verified_legacy_primary_alias",
        });
        return { kind: "renewed" };
      }
    }
    await set(
      transitionCalendarWatchToActionRequired$,
      {
        state: args.state,
        reason:
          args.state.calendarId === GOOGLE_CALENDAR_PRIMARY_ID
            ? "reconnect_required"
            : "calendar_not_found",
      },
      signal,
    );
    return { kind: "failed" };
  },
);

export const reconcileGoogleCalendarWatchState$ = command(
  async (
    { set },
    args: {
      readonly connectorId: string;
      readonly calendarId: string;
      readonly forceStop?: boolean;
      readonly renewBefore?: Date;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchReconcileResult> => {
    const state = await set(loadCalendarWatchState$, args, signal);
    if (!state) {
      return { kind: "unchanged" };
    }
    const hasConsumer =
      !args.forceStop &&
      (await set(hasEnabledGoogleCalendarConsumer$, state, signal));
    if (!hasConsumer) {
      const access = await set(
        resolveGoogleCalendarAccess$,
        { ...state, refreshExpiredToken: false },
        signal,
      );
      const deleted = await set(
        deleteInactiveCalendarWatch$,
        { state },
        signal,
      );
      if (!deleted) {
        return { kind: "unchanged" };
      }
      if (access.kind === "ok" && state.resourceId) {
        await stopCalendarChannelWithLifecycleOwnership({
          accessToken: access.access.accessToken,
          channel: state,
        });
      }
      return { kind: "stopped" };
    }

    if (
      args.renewBefore === undefined ||
      (!state.needsRewatch &&
        state.actionRequiredReason === null &&
        state.watchExpirationAt > args.renewBefore)
    ) {
      return { kind: "unchanged" };
    }
    const access = await set(resolveGoogleCalendarAccess$, state, signal);
    if (access.kind !== "ok") {
      return { kind: "failed" };
    }
    const episode = calendarWatchActionRequiredEpisode(state);
    if (episode && state.calendarId !== GOOGLE_CALENDAR_PRIMARY_ID) {
      return await set(
        reconcileActionRequiredNonPrimaryCalendarWatch$,
        { access: access.access, state, episode },
        signal,
      );
    }
    const registered = await set(
      ensureGoogleCalendarWatchForUser$,
      {
        ...state,
        forceRefresh: true,
        renewal: true,
        reportProviderFailure: false,
      },
      signal,
    );
    if (registered.kind === "ok") {
      return { kind: "renewed" };
    }
    if (registered.providerFailure?.status === 404) {
      const exactTarget = await probeExactCalendarTarget(
        {
          accessToken: access.access.accessToken,
          calendarId: state.calendarId,
        },
        signal,
      );
      if (exactTarget === "missing") {
        return await set(
          reconcileConfirmedMissingCalendarWatch$,
          {
            access: access.access,
            state,
            providerFailure: registered.providerFailure,
          },
          signal,
        );
      }
    }
    if (registered.providerFailure) {
      logCalendarWatchProviderFailure("renew", registered.providerFailure);
    }
    return { kind: "failed" };
  },
);

export const reconcileGoogleCalendarWatchesForUser$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId?: string;
      readonly calendarId?: string;
      readonly renewBefore?: Date;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    let succeeded = await set(
      repairAndEnsureGoogleCalendarWatchesForOwner$,
      args,
      signal,
    );
    const states = await db
      .select({
        connectorId: googleCalendarWatchStates.connectorId,
        calendarId: googleCalendarWatchStates.calendarId,
      })
      .from(googleCalendarWatchStates)
      .where(
        and(
          eq(googleCalendarWatchStates.orgId, args.orgId),
          eq(googleCalendarWatchStates.userId, args.userId),
          ...(args.connectorId === undefined
            ? []
            : [eq(googleCalendarWatchStates.connectorId, args.connectorId)]),
          ...(args.calendarId === undefined
            ? []
            : [eq(googleCalendarWatchStates.calendarId, args.calendarId)]),
        ),
      );
    signal.throwIfAborted();
    for (const state of states) {
      const result = await set(
        reconcileGoogleCalendarWatchState$,
        {
          connectorId: state.connectorId,
          calendarId: state.calendarId,
          renewBefore: args.renewBefore,
        },
        signal,
      );
      succeeded &&= result.kind !== "failed";
    }
    return succeeded;
  },
);

export const repairAndEnsureGoogleCalendarWatchesForOwner$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId?: string;
      readonly calendarId?: string;
      readonly ensureRefreshRequired?: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    await set(repairGoogleCalendarAutomationProjections$, args);
    signal.throwIfAborted();
    const targets = await set(loadEnabledGoogleCalendarTargets$, args);
    signal.throwIfAborted();
    const existingStates = await db
      .select({
        connectorId: googleCalendarWatchStates.connectorId,
        calendarId: googleCalendarWatchStates.calendarId,
        actionRequiredReason: googleCalendarWatchStates.actionRequiredReason,
        needsRewatch: googleCalendarWatchStates.needsRewatch,
        syncToken: googleCalendarWatchStates.syncToken,
        watchExpirationAt: googleCalendarWatchStates.watchExpirationAt,
      })
      .from(googleCalendarWatchStates)
      .where(
        and(
          eq(googleCalendarWatchStates.orgId, args.orgId),
          eq(googleCalendarWatchStates.userId, args.userId),
          ...(args.connectorId === undefined
            ? []
            : [eq(googleCalendarWatchStates.connectorId, args.connectorId)]),
          ...(args.calendarId === undefined
            ? []
            : [eq(googleCalendarWatchStates.calendarId, args.calendarId)]),
        ),
      );
    signal.throwIfAborted();
    const existingByKey = new Map(
      existingStates.map((state) => {
        return [`${state.connectorId}\n${state.calendarId}`, state] as const;
      }),
    );
    let succeeded = true;
    for (const target of targets) {
      const existing = existingByKey.get(
        `${target.connectorId}\n${target.calendarId}`,
      );
      if (
        existing &&
        (args.ensureRefreshRequired === false ||
          !watchNeedsRefresh(existing, nowDate()))
      ) {
        continue;
      }
      const ensured = await set(
        ensureGoogleCalendarWatchForUser$,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorId: target.connectorId,
          calendarId: target.calendarId,
        },
        signal,
      );
      signal.throwIfAborted();
      succeeded &&= ensured.kind === "ok";
    }
    return succeeded;
  },
);

export const repairGoogleCalendarAutomationProjections$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
    // One conditional UPDATE computes each target from the member's current
    // account set and default; an account change committed after its
    // snapshot is picked up by the next repair.
    await db.execute(googleCalendarAccountProjectionStatement(args));
  },
);

const loadEnabledGoogleCalendarTargets$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId?: string;
      readonly calendarId?: string;
    },
  ): Promise<
    readonly {
      readonly connectorId: string;
      readonly calendarId: string;
    }[]
  > => {
    const db = set(writeDb$);
    const consumers = await db
      .select({
        connectorId: workflowAutomations.eventConnectorId,
        eventType: workflowAutomations.eventType,
        eventConfig: workflowAutomations.eventConfig,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          isNotNull(workflowAutomations.eventConnectorId),
          inArray(workflowAutomations.eventType, [
            ...GOOGLE_CALENDAR_EVENT_TYPES,
          ]),
        ),
      );
    const targets = new Map<
      string,
      {
        readonly connectorId: string;
        readonly calendarId: string;
      }
    >();
    for (const consumer of consumers) {
      if (consumer.connectorId === null) {
        continue;
      }
      const config = parseGoogleCalendarEventAutomationConfig({
        eventType: consumer.eventType,
        eventConfig: consumer.eventConfig,
      });
      if (
        !config ||
        (args.connectorId !== undefined &&
          consumer.connectorId !== args.connectorId) ||
        (args.calendarId && config.calendarId !== args.calendarId)
      ) {
        continue;
      }
      const target = {
        connectorId: consumer.connectorId,
        calendarId: config.calendarId,
      };
      targets.set(`${target.connectorId}\n${target.calendarId}`, target);
    }
    return [...targets.values()];
  },
);

export function parseGoogleCalendarEventAutomationConfig(
  automation: Pick<AutomationRow, "eventType" | "eventConfig">,
): {
  readonly calendarId: string;
} | null {
  if (automation.eventType === "google-calendar-event-created") {
    const config = googleCalendarEventCreatedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? { calendarId: config.data.calendarId } : null;
  }
  if (automation.eventType === "google-calendar-event-updated") {
    const config = googleCalendarEventUpdatedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? { calendarId: config.data.calendarId } : null;
  }
  if (automation.eventType === "google-calendar-event-cancelled") {
    const config = googleCalendarEventCancelledEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? { calendarId: config.data.calendarId } : null;
  }
  return null;
}

export interface PendingGoogleCalendarWatchStop {
  readonly accessToken: string;
  readonly channels: readonly GoogleCalendarChannelIdentity[];
}

export function normalizeGoogleCalendarId(
  calendarId: string,
  emailAddress: string | null,
): string {
  return emailAddress !== null &&
    emailAddress.toLowerCase() === calendarId.toLowerCase()
    ? GOOGLE_CALENDAR_PRIMARY_ID
    : calendarId;
}

export const normalizeGoogleCalendarIdForConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly calendarId: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    if (args.calendarId === GOOGLE_CALENDAR_PRIMARY_ID) {
      return args.calendarId;
    }
    const snapshot = await loadConnectorRuntimeAuthSelection(set(writeDb$), {
      connectorSlugs: ["google-calendar"],
    });
    signal.throwIfAborted();
    const loaded = await set(loadBuiltinConnectorCredentialConnection$, {
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: "google-calendar",
      connectorId: args.connectorId,
    });
    signal.throwIfAborted();
    if (loaded.kind === "missing" || loaded.kind === "unavailable") {
      return args.calendarId;
    }
    return normalizeGoogleCalendarId(
      args.calendarId,
      loaded.connection.externalEmail,
    );
  },
);

export const reconcileGoogleCalendarWatchTarget$ = command(
  async (
    { set },
    args: {
      readonly connectorId: string;
      readonly calendarId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(reconcileGoogleCalendarWatchState$, args, signal);
    return result.kind !== "failed";
  },
);

export const releaseStagedGoogleCalendarWatchTarget$ = command(
  async (
    { set },
    args: {
      readonly stagedTarget: StagedGoogleCalendarWatchTarget;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(
      reconcileGoogleCalendarWatchTarget$,
      { ...args.stagedTarget },
      signal,
    );
  },
);

export const prepareGoogleCalendarWatchStopForConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<PendingGoogleCalendarWatchStop | null> => {
    const db = set(writeDb$);
    const states = await db
      .select()
      .from(googleCalendarWatchStates)
      .where(
        and(
          eq(googleCalendarWatchStates.orgId, args.orgId),
          eq(googleCalendarWatchStates.userId, args.userId),
          eq(googleCalendarWatchStates.connectorId, args.connectorId),
        ),
      );
    signal.throwIfAborted();
    const channels = new Map<string, GoogleCalendarChannelIdentity>();
    for (const state of states) {
      if (state.resourceId !== "") {
        const channel = {
          channelId: state.channelId,
          channelToken: state.channelToken,
          resourceId: state.resourceId,
        };
        channels.set(`${channel.channelId}\n${channel.resourceId}`, channel);
      }
    }
    if (channels.size === 0) {
      return null;
    }
    const access = await set(
      resolveGoogleCalendarAccess$,
      { ...args, refreshExpiredToken: false },
      signal,
    );
    signal.throwIfAborted();
    return access.kind === "ok"
      ? {
          accessToken: access.access.accessToken,
          channels: [...channels.values()],
        }
      : null;
  },
);

export async function stopPreparedGoogleCalendarWatches(
  pending: PendingGoogleCalendarWatchStop,
): Promise<void> {
  let failed = false;
  for (const channel of pending.channels) {
    const stopped = await stopCalendarChannelWithLifecycleOwnership({
      accessToken: pending.accessToken,
      channel,
    });
    failed ||= !stopped;
  }
  if (failed) {
    throw new Error(
      "Failed to stop one or more Google Calendar watch channels",
    );
  }
}
