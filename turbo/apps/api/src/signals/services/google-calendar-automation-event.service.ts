import { createHash, randomBytes, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  type GoogleCalendarWatchActionRequiredReason,
} from "@okouai/api-contracts/contracts/workflows";
import {
  googleCalendarEventSnapshots,
  googleCalendarProcessedEvents,
  googleCalendarWatchStates,
} from "@okouai/db/schema/google-calendar-event";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { apiBackendUrl } from "../../lib/api-backend-url";
import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { webUrl } from "../../lib/web-url";
import { writeDb$, type Db } from "../external/db";
import { onRejection, settle, tapError } from "../utils";
import { nowDate } from "../../lib/time";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
} from "./connector-credential-runtime.service";
import {
  AutomationEventSourceTiming,
  type AutomationEventRunTiming,
} from "./automation-event-source-timing.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import type { AutomationRow } from "./workflow-automation-launch.service";
import type { WorkflowQueueAdmissionTransaction } from "./workflow-chat-event-queue.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { workflowAutomationCanFire } from "./workflow-automation-access.service";
import { ensureWorkflowUserAutomationThread } from "./workflow-user-automation-thread.service";
import {
  GOOGLE_CALENDAR_PRIMARY_ID,
  GOOGLE_CALENDAR_EVENT_TYPES,
  migrateGoogleCalendarAutomationTargets,
  reprojectGoogleCalendarAutomationsForOwner,
} from "./google-calendar-automation-account.service";

const log = logger("api:google-calendar-automation-event");

const GOOGLE_CALENDAR_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_CALENDAR_TOKEN";
const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const WATCH_TTL_SECONDS = 7 * 24 * 60 * 60;
const WATCH_LIFECYCLE_TIMEOUT_MS = 30 * 1000;
const CALENDAR_EVENTS_PAGE_SIZE = 2500;
const ATTENDEE_PROMPT_LIMIT = 20;
interface GoogleCalendarAccess {
  readonly connectorId: string;
  readonly emailAddress: string | null;
  readonly accessToken: string;
}

type GoogleCalendarAccessResult =
  | { readonly kind: "ok"; readonly access: GoogleCalendarAccess }
  | { readonly kind: "bad_request"; readonly message: string };

interface GoogleCalendarProviderFailure {
  readonly stage: "watch_registration";
  readonly status: number;
  readonly reason: string;
}

type EnsureGoogleCalendarWatchResult =
  | { readonly kind: "ok" }
  | {
      readonly kind: "bad_request";
      readonly message: string;
      readonly providerFailure?: GoogleCalendarProviderFailure;
    };

type GoogleCalendarWatchReconcileResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "renewed" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed" };

type GoogleCalendarWatchTargetType =
  | "primary"
  | "explicit_calendar"
  | "verified_legacy_primary_alias";

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
  | GoogleCalendarFetchOk<T>
  | GoogleCalendarFetchError;

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

const calendarEventAttendeeSchema = calendarEventPersonSchema.extend({
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

type GoogleCalendarEvent = z.infer<typeof calendarEventSchema>;
type GoogleCalendarWatchStateRow =
  typeof googleCalendarWatchStates.$inferSelect;
type GoogleCalendarEventSnapshotRow =
  typeof googleCalendarEventSnapshots.$inferSelect;
type GoogleCalendarChangeType = "created" | "updated" | "cancelled";

interface GoogleCalendarEventAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
}

interface GoogleCalendarWebhookNotification {
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
  readonly resourceState: string;
  readonly messageNumber: string | null;
}

interface GoogleCalendarChannelIdentity {
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
}

export interface PendingGoogleCalendarWatchStop {
  readonly accessToken: string;
  readonly channels: readonly GoogleCalendarChannelIdentity[];
}

interface PreparedGoogleCalendarWatch {
  readonly stateId: string;
  readonly channelId: string;
  readonly channelToken: string;
  readonly previousState: GoogleCalendarWatchStateRow | null;
}

interface CalendarEventContext {
  readonly changeType: GoogleCalendarChangeType;
  readonly calendarId: string;
  readonly eventId: string;
  readonly summary: string | null;
  readonly status: string | null;
  readonly eventType: string | null;
  readonly htmlLink: string | null;
  readonly start: GoogleCalendarEvent["start"] | null;
  readonly end: GoogleCalendarEvent["end"] | null;
  readonly organizer: GoogleCalendarEvent["organizer"] | null;
  readonly attendees: readonly z.infer<typeof calendarEventAttendeeSchema>[];
  readonly created: string | null;
  readonly updated: string | null;
  readonly recurringEventId: string | null;
  readonly originalStartTime: GoogleCalendarEvent["originalStartTime"] | null;
  readonly previousSnapshot: Record<string, unknown> | null;
  readonly changedFields: readonly string[];
}

interface CalendarEventChange {
  readonly changeType: GoogleCalendarChangeType;
  readonly event: GoogleCalendarEvent;
  readonly eventChangeKey: string;
  readonly previousSnapshot: Record<string, unknown> | null;
  readonly changedFields: readonly string[];
}

type GoogleCalendarRunStarter = (args: {
  readonly automation: GoogleCalendarEventAutomationRow;
  readonly state: GoogleCalendarWatchStateRow;
  readonly notification: GoogleCalendarWebhookNotification;
  readonly event: CalendarEventContext;
  // Unique per change of the same calendar event; repeated updates of one event
  // are otherwise indistinguishable.
  readonly eventChangeKey: string;
  readonly timing: AutomationEventRunTiming;
}) => Promise<"ok" | "error" | "superseded">;

interface GoogleCalendarWorkflowRunStartTestInput {
  readonly automationId: string;
  readonly workflowName: string;
  readonly changeType: GoogleCalendarChangeType;
  readonly calendarId: string;
  readonly eventId: string;
  readonly summary: string | null;
}

type GoogleCalendarBeforeRunStartTestHook = (
  args: GoogleCalendarWorkflowRunStartTestInput,
) => Promise<void>;

const googleCalendarBeforeRunStartHook = testOverride<
  GoogleCalendarBeforeRunStartTestHook | undefined
>(() => {
  return undefined;
});

export function setGoogleCalendarBeforeRunStartHookForTest(
  hook: GoogleCalendarBeforeRunStartTestHook,
): void {
  googleCalendarBeforeRunStartHook.set(hook);
}

export function clearGoogleCalendarBeforeRunStartHookForTest(): void {
  googleCalendarBeforeRunStartHook.clear();
}

class GoogleCalendarAutomationSourceChangedError extends Error {
  constructor() {
    super(
      "Google Calendar automation source changed before durable queue admission",
    );
    this.name = "GoogleCalendarAutomationSourceChangedError";
  }
}

type GoogleCalendarDispatchStateResult =
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "run_error"; readonly message: string };

type GoogleCalendarWebhookResult =
  | {
      readonly kind: "ok";
      readonly watchStates: number;
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "run_error"; readonly message: string };

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

function normalizeGoogleCalendarId(
  calendarId: string,
  emailAddress: string | null,
): string {
  return emailAddress !== null &&
    emailAddress.toLowerCase() === calendarId.toLowerCase()
    ? GOOGLE_CALENDAR_PRIMARY_ID
    : calendarId;
}

export async function normalizeGoogleCalendarIdForConnector(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly calendarId: string;
  },
  signal: AbortSignal,
): Promise<string> {
  if (args.calendarId === GOOGLE_CALENDAR_PRIMARY_ID) {
    return args.calendarId;
  }
  const snapshot = await loadConnectorRuntimeSnapshot(db);
  signal.throwIfAborted();
  const loaded = await loadConnectorCredentialConnection({
    db,
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
}

async function resolveGoogleCalendarAccess(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly refreshExpiredToken?: boolean;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarAccessResult> {
  const currentTime = nowDate();
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  signal.throwIfAborted();
  const loaded = await loadConnectorCredentialConnection({
    db: args.db,
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
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
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
  const values = await loadConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
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
  const refreshed = await refreshConnectorCredentialAccess(
    {
      connection,
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      runtimeEnvironmentName: GOOGLE_CALENDAR_ACCESS_TOKEN_ENVIRONMENT_NAME,
      persist: { db: args.db, markNeedsReconnectOnFailure: true },
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
}

export async function googleCalendarAutomationTargetMatchesConnector(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly requestedCalendarId: string;
    readonly normalizedCalendarId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const access = await resolveGoogleCalendarAccess(
    { ...args, refreshExpiredToken: false },
    signal,
  );
  signal.throwIfAborted();
  return (
    access.kind === "ok" &&
    normalizeGoogleCalendarId(
      args.requestedCalendarId,
      access.access.emailAddress,
    ) === args.normalizedCalendarId
  );
}

/**
 * Lock a staged target through the caller's transaction and prove that the
 * provider watch and baseline are still ready. Callers must already hold the
 * connector-account lock so the shared account -> lifecycle lock order is
 * preserved.
 */
export async function lockReadyGoogleCalendarWatchTarget(
  args: {
    readonly db: Tx;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly calendarId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  await lockGoogleCalendarLifecycle(args.db, args.connectorId, args.calendarId);
  signal.throwIfAborted();
  const state = await loadCalendarWatchState(args, signal);
  return (
    state !== null &&
    state.orgId === args.orgId &&
    state.userId === args.userId &&
    state.resourceId.length > 0 &&
    !watchNeedsRefresh(state, nowDate())
  );
}

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
  args: { readonly accessToken: string; readonly calendarId: string },
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

function previousCalendarChannel(
  state: GoogleCalendarWatchStateRow,
): GoogleCalendarChannelIdentity | null {
  const values = [
    state.previousChannelId,
    state.previousChannelToken,
    state.previousResourceId,
  ];
  if (
    values.every((value) => {
      return value === null;
    })
  ) {
    return null;
  }
  if (
    values.some((value) => {
      return value === null;
    })
  ) {
    throw new Error("Incomplete previous Google Calendar channel identity");
  }
  return {
    channelId: state.previousChannelId!,
    channelToken: state.previousChannelToken!,
    resourceId: state.previousResourceId!,
  };
}

async function stopCalendarChannelWithLifecycleOwnership(args: {
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
  | { readonly kind: "stale_cursor" }
  | { readonly kind: "calendar_error"; readonly message: string };
type CalendarEventsListOk = Extract<
  CalendarEventsListResult,
  { readonly kind: "ok" }
>;

async function listCalendarEvents(
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
        : { kind: "calendar_error", message: result.message };
    }

    events.push(...(result.value.items ?? []));
    pageToken = result.value.nextPageToken ?? null;
    nextSyncToken = result.value.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  if (!nextSyncToken) {
    return {
      kind: "calendar_error",
      message: "Google Calendar did not return a nextSyncToken",
    };
  }

  return { kind: "ok", events, nextSyncToken };
}

function parseGoogleDate(value: string | undefined): Date | null {
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

function eventPromptContext(
  calendarId: string,
  change: CalendarEventChange,
): CalendarEventContext {
  const { event } = change;
  return {
    changeType: change.changeType,
    calendarId,
    eventId: event.id,
    summary: event.summary ?? null,
    status: event.status ?? null,
    eventType: event.eventType ?? null,
    htmlLink: event.htmlLink ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    organizer: event.organizer ?? null,
    attendees: event.attendees ?? [],
    created: event.created ?? null,
    updated: event.updated ?? null,
    recurringEventId: event.recurringEventId ?? null,
    originalStartTime: event.originalStartTime ?? null,
    previousSnapshot: change.previousSnapshot,
    changedFields: change.changedFields,
  };
}

function eventSnapshotValue(
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

function eventSnapshotHash(event: GoogleCalendarEvent): string {
  return createHash("sha256")
    .update(JSON.stringify(eventSnapshotValue(event)))
    .digest("hex");
}

function eventChangeKey(
  changeType: GoogleCalendarChangeType,
  event: GoogleCalendarEvent,
): string {
  if (changeType === "created") {
    return "created";
  }
  if (changeType === "cancelled") {
    if (event.etag) {
      return `cancelled:etag:${event.etag}`;
    }
    if (event.updated) {
      return `cancelled:updated:${event.updated}`;
    }
    return `cancelled:${event.id}`;
  }
  if (event.etag) {
    return `etag:${event.etag}`;
  }
  if (event.updated) {
    return `updated:${event.updated}`;
  }
  return `snapshot:${eventSnapshotHash(event)}`;
}

function eventSnapshotChanged(
  previousSnapshot: Record<string, unknown> | null,
  currentSnapshot: Record<string, unknown>,
): boolean {
  if (!previousSnapshot) {
    return true;
  }
  return JSON.stringify(previousSnapshot) !== JSON.stringify(currentSnapshot);
}

function eventRevisionChanged(args: {
  readonly previous: GoogleCalendarEventSnapshotRow;
  readonly event: GoogleCalendarEvent;
  readonly currentSnapshot: Record<string, unknown>;
}): boolean {
  if (args.previous.etag && args.event.etag) {
    return args.previous.etag !== args.event.etag;
  }

  const eventUpdatedAt = parseGoogleDate(args.event.updated);
  if (args.previous.eventUpdatedAt && eventUpdatedAt) {
    return args.previous.eventUpdatedAt.getTime() !== eventUpdatedAt.getTime();
  }

  return eventSnapshotChanged(
    args.previous.snapshot ?? null,
    args.currentSnapshot,
  );
}

function changedCalendarEventFields(
  previousSnapshot: Record<string, unknown> | null,
  currentSnapshot: Record<string, unknown>,
): string[] {
  if (!previousSnapshot) {
    return [];
  }

  const fields = new Set([
    ...Object.keys(previousSnapshot),
    ...Object.keys(currentSnapshot),
  ]);
  return Array.from(fields)
    .filter((field) => {
      return (
        JSON.stringify(previousSnapshot[field]) !==
        JSON.stringify(currentSnapshot[field])
      );
    })
    .sort();
}

function calendarEventChangeForSnapshot(args: {
  readonly event: GoogleCalendarEvent;
  readonly previous: GoogleCalendarEventSnapshotRow | undefined;
}): CalendarEventChange | null {
  const currentSnapshot = eventSnapshotValue(args.event);
  if (args.event.status === "cancelled") {
    if (
      args.previous?.status === "cancelled" &&
      !eventRevisionChanged({
        previous: args.previous,
        event: args.event,
        currentSnapshot,
      })
    ) {
      return null;
    }
    return {
      changeType: "cancelled",
      event: args.event,
      eventChangeKey: eventChangeKey("cancelled", args.event),
      previousSnapshot: args.previous?.snapshot ?? null,
      changedFields: changedCalendarEventFields(
        args.previous?.snapshot ?? null,
        currentSnapshot,
      ),
    };
  }

  if (!args.previous) {
    return {
      changeType: "created",
      event: args.event,
      eventChangeKey: eventChangeKey("created", args.event),
      previousSnapshot: null,
      changedFields: [],
    };
  }

  if (
    !eventRevisionChanged({
      previous: args.previous,
      event: args.event,
      currentSnapshot,
    })
  ) {
    return null;
  }

  return {
    changeType: "updated",
    event: args.event,
    eventChangeKey: eventChangeKey("updated", args.event),
    previousSnapshot: args.previous.snapshot ?? null,
    changedFields: changedCalendarEventFields(
      args.previous.snapshot ?? null,
      currentSnapshot,
    ),
  };
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

async function upsertCalendarEventSnapshots(
  args: {
    readonly db: Db;
    readonly watchStateId: string;
    readonly events: readonly GoogleCalendarEvent[];
    readonly currentTime: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.events.length === 0) {
    return;
  }

  await args.db
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
}

async function baselineCalendarWatchState(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<EnsureGoogleCalendarWatchResult> {
  const baseline = await listCalendarEvents(
    {
      accessToken: args.accessToken,
      calendarId: args.state.calendarId,
      syncToken: null,
    },
    signal,
  );
  signal.throwIfAborted();
  if (baseline.kind !== "ok") {
    return {
      kind: "bad_request",
      message:
        baseline.kind === "stale_cursor"
          ? "Failed to establish Google Calendar event automation baseline"
          : baseline.message,
    };
  }

  const currentTime = nowDate();
  await upsertCalendarEventSnapshots(
    {
      db: args.db,
      watchStateId: args.state.id,
      events: baseline.events,
      currentTime,
    },
    signal,
  );

  await args.db
    .update(googleCalendarWatchStates)
    .set({
      syncToken: baseline.nextSyncToken,
      needsRewatch: false,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(googleCalendarWatchStates.id, args.state.id),
        isNull(googleCalendarWatchStates.actionRequiredReason),
        isNull(googleCalendarWatchStates.actionRequiredAt),
      ),
    );
  signal.throwIfAborted();

  return { kind: "ok" };
}

async function loadCalendarWatchState(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly calendarId: string;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarWatchStateRow | null> {
  const [state] = await args.db
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
}

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

function calendarWatchActionRequiredEpisode(
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

function googleCalendarWatchTargetType(
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

function googleCalendarLifecycleLockKey(
  connectorId: string,
  calendarId: string,
): string {
  const scopeHash = createHash("sha256")
    .update(`${connectorId}\n${calendarId}`)
    .digest("hex");
  return `workflow_watch:google_calendar:${scopeHash}`;
}

async function lockGoogleCalendarLifecycle(
  db: Db,
  connectorId: string,
  calendarId: string,
): Promise<void> {
  const lockKey = googleCalendarLifecycleLockKey(connectorId, calendarId);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

export async function hasEnabledGoogleCalendarConsumer(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly calendarId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const automations = await args.db
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
}

async function transitionCalendarWatchToActionRequired(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly reason: GoogleCalendarWatchActionRequiredReason;
  },
  signal: AbortSignal,
): Promise<void> {
  const transition = await args.db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, {
      orgId: args.state.orgId,
      userId: args.state.userId,
      target: { kind: "builtin", connectorSlug: "google-calendar" },
    });
    await lockGoogleCalendarLifecycle(
      tx,
      args.state.connectorId,
      args.state.calendarId,
    );
    const current = await loadCalendarWatchState(
      {
        db: tx,
        connectorId: args.state.connectorId,
        calendarId: args.state.calendarId,
      },
      signal,
    );
    if (!current || current.id !== args.state.id) {
      return { kind: "superseded" } as const;
    }
    const currentEpisode = calendarWatchActionRequiredEpisode(current);
    const hasConsumer = await hasEnabledGoogleCalendarConsumer(
      {
        db: tx,
        orgId: current.orgId,
        userId: current.userId,
        connectorId: current.connectorId,
        calendarId: current.calendarId,
      },
      signal,
    );
    if (!hasConsumer) {
      return { kind: "superseded" } as const;
    }
    if (currentEpisode?.reason === args.reason) {
      return {
        kind: "unchanged",
        state: current,
        episode: currentEpisode,
      } as const;
    }
    const currentTime = nowDate();
    const [updated] = await tx
      .update(googleCalendarWatchStates)
      .set({
        actionRequiredReason: args.reason,
        actionRequiredAt: currentTime,
        needsRewatch: true,
        updatedAt: currentTime,
      })
      .where(eq(googleCalendarWatchStates.id, current.id))
      .returning();
    if (!updated) {
      throw new Error(
        "Failed to persist Google Calendar action-required state",
      );
    }
    return {
      kind: "started",
      state: updated,
      episode: {
        reason: args.reason,
        startedAt: currentTime,
      },
    } as const;
  });
  signal.throwIfAborted();
  if (transition.kind === "superseded") {
    return;
  }
  const fields = {
    provider: "google_calendar",
    action: "suspend",
    result: transition.kind === "started" ? "action_required" : "unchanged",
    reason: transition.episode.reason,
    watchStateId: transition.state.id,
    episodeStartedAt: transition.episode.startedAt.toISOString(),
    targetType: googleCalendarWatchTargetType(transition.state.calendarId),
  };
  if (transition.kind === "started") {
    log.warn("Workflow watch requires user action", fields);
  } else {
    log.debug("Workflow watch action-required episode unchanged", fields);
  }
}

async function prepareCalendarWatch(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly access: GoogleCalendarAccess;
    readonly calendarId: string;
    readonly previousState: GoogleCalendarWatchStateRow | null;
    readonly resetBaseline: boolean;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "prepared";
      readonly prepared: PreparedGoogleCalendarWatch;
    }
  | { readonly kind: "bad_request"; readonly message: string }
> {
  if (
    args.previousState &&
    (previousCalendarChannel(args.previousState) ||
      args.previousState.resourceId.length === 0)
  ) {
    return {
      kind: "bad_request",
      message: "Google Calendar watch setup or cleanup is still pending",
    };
  }

  const baselineResult = await establishCalendarWatchBaseline(args, signal);
  if (baselineResult.kind !== "ok") {
    return baselineResult;
  }

  const channelId = randomUUID();
  const channelToken = mintChannelToken();
  const currentTime = nowDate();
  const state = await persistPendingCalendarWatch(
    {
      ...args,
      baseline: baselineResult.baseline,
      channelId,
      channelToken,
      currentTime,
    },
    signal,
  );
  await replaceCalendarWatchBaselineSnapshots(
    {
      db: args.db,
      stateId: state.id,
      baseline: baselineResult.baseline,
      currentTime,
    },
    signal,
  );

  return {
    kind: "prepared",
    prepared: {
      stateId: state.id,
      channelId,
      channelToken,
      previousState: args.previousState,
    },
  };
}

async function establishCalendarWatchBaseline(
  args: {
    readonly access: GoogleCalendarAccess;
    readonly calendarId: string;
    readonly resetBaseline: boolean;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok"; readonly baseline: CalendarEventsListOk | null }
  | { readonly kind: "bad_request"; readonly message: string }
> {
  if (!args.resetBaseline) {
    return { kind: "ok", baseline: null };
  }
  const baseline = await listCalendarEvents(
    {
      accessToken: args.access.accessToken,
      calendarId: args.calendarId,
      syncToken: null,
    },
    signal,
  );
  signal.throwIfAborted();
  if (baseline.kind !== "ok") {
    return {
      kind: "bad_request",
      message: "Failed to establish Google Calendar event automation baseline",
    };
  }
  return { kind: "ok", baseline };
}

async function persistPendingCalendarWatch(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly access: GoogleCalendarAccess;
    readonly calendarId: string;
    readonly previousState: GoogleCalendarWatchStateRow | null;
    readonly baseline: CalendarEventsListOk | null;
    readonly channelId: string;
    readonly channelToken: string;
    readonly currentTime: Date;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarWatchStateRow> {
  const previousChannel = args.previousState
    ? {
        channelId: args.previousState.channelId,
        channelToken: args.previousState.channelToken,
        resourceId: args.previousState.resourceId,
      }
    : null;
  const syncToken =
    args.baseline?.nextSyncToken ?? args.previousState?.syncToken ?? null;
  const [state] = await args.db
    .insert(googleCalendarWatchStates)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.access.connectorId,
      calendarId: args.calendarId,
      channelId: args.channelId,
      channelToken: args.channelToken,
      resourceId: "",
      resourceUri: "",
      previousChannelId: previousChannel?.channelId ?? null,
      previousChannelToken: previousChannel?.channelToken ?? null,
      previousResourceId: previousChannel?.resourceId ?? null,
      syncToken,
      watchExpirationAt: watchExpirationDate(undefined, args.currentTime),
      lastWatchRenewedAt: args.currentTime,
      needsRewatch: true,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .onConflictDoUpdate({
      target: [
        googleCalendarWatchStates.connectorId,
        googleCalendarWatchStates.calendarId,
      ],
      set: {
        orgId: args.orgId,
        userId: args.userId,
        channelId: args.channelId,
        channelToken: args.channelToken,
        resourceId: "",
        resourceUri: "",
        previousChannelId: previousChannel?.channelId ?? null,
        previousChannelToken: previousChannel?.channelToken ?? null,
        previousResourceId: previousChannel?.resourceId ?? null,
        ...(args.baseline ? { syncToken: args.baseline.nextSyncToken } : {}),
        watchExpirationAt: watchExpirationDate(undefined, args.currentTime),
        lastWatchRenewedAt: args.currentTime,
        needsRewatch: true,
        updatedAt: args.currentTime,
      },
    })
    .returning();
  signal.throwIfAborted();
  if (!state) {
    throw new Error("Failed to persist pending Google Calendar watch state");
  }
  return state;
}

async function replaceCalendarWatchBaselineSnapshots(
  args: {
    readonly db: Db;
    readonly stateId: string;
    readonly baseline: CalendarEventsListOk | null;
    readonly currentTime: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!args.baseline) {
    return;
  }
  await args.db
    .delete(googleCalendarEventSnapshots)
    .where(eq(googleCalendarEventSnapshots.watchStateId, args.stateId));
  signal.throwIfAborted();
  await upsertCalendarEventSnapshots(
    {
      db: args.db,
      watchStateId: args.stateId,
      events: args.baseline.events,
      currentTime: args.currentTime,
    },
    signal,
  );
}

async function restorePreparedCalendarWatch(args: {
  readonly db: Db;
  readonly access: GoogleCalendarAccess;
  readonly calendarId: string;
  readonly prepared: PreparedGoogleCalendarWatch;
}): Promise<void> {
  const lifecycleSignal = AbortSignal.timeout(WATCH_LIFECYCLE_TIMEOUT_MS);
  await args.db.transaction(async (tx) => {
    await lockGoogleCalendarLifecycle(
      tx,
      args.access.connectorId,
      args.calendarId,
    );
    const current = await loadCalendarWatchState(
      {
        db: tx,
        connectorId: args.access.connectorId,
        calendarId: args.calendarId,
      },
      lifecycleSignal,
    );
    if (
      !current ||
      current.id !== args.prepared.stateId ||
      current.channelId !== args.prepared.channelId
    ) {
      return;
    }
    const retainedPrevious = previousCalendarChannel(current);
    const previous = args.prepared.previousState;
    if (!retainedPrevious) {
      await tx
        .delete(googleCalendarWatchStates)
        .where(
          and(
            eq(googleCalendarWatchStates.id, args.prepared.stateId),
            eq(googleCalendarWatchStates.channelId, args.prepared.channelId),
          ),
        );
      return;
    }
    if (
      !previous ||
      previous.channelId !== retainedPrevious.channelId ||
      previous.channelToken !== retainedPrevious.channelToken ||
      previous.resourceId !== retainedPrevious.resourceId
    ) {
      throw new Error("Prepared Google Calendar watch state changed");
    }
    await tx
      .update(googleCalendarWatchStates)
      .set({
        channelId: previous.channelId,
        channelToken: previous.channelToken,
        resourceId: previous.resourceId,
        resourceUri: previous.resourceUri,
        previousChannelId: null,
        previousChannelToken: null,
        previousResourceId: null,
        syncToken: previous.syncToken,
        watchExpirationAt: previous.watchExpirationAt,
        lastWatchRenewedAt: previous.lastWatchRenewedAt,
        needsRewatch: previous.needsRewatch,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(googleCalendarWatchStates.id, args.prepared.stateId),
          eq(googleCalendarWatchStates.channelId, args.prepared.channelId),
        ),
      );
  });
}

async function retainRegisteredCalendarWatchForRetry(args: {
  readonly db: Db;
  readonly access: GoogleCalendarAccess;
  readonly calendarId: string;
  readonly prepared: PreparedGoogleCalendarWatch;
  readonly resourceId: string;
  readonly resourceUri: string;
  readonly expiration: string | number | undefined;
}): Promise<void> {
  const lifecycleSignal = AbortSignal.timeout(WATCH_LIFECYCLE_TIMEOUT_MS);
  await args.db.transaction(async (tx) => {
    await lockGoogleCalendarLifecycle(
      tx,
      args.access.connectorId,
      args.calendarId,
    );
    const currentTime = nowDate();
    await tx
      .update(googleCalendarWatchStates)
      .set({
        resourceId: args.resourceId,
        resourceUri: args.resourceUri,
        watchExpirationAt: watchExpirationDate(args.expiration, currentTime),
        needsRewatch: true,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(googleCalendarWatchStates.id, args.prepared.stateId),
          eq(googleCalendarWatchStates.channelId, args.prepared.channelId),
        ),
      );
    lifecycleSignal.throwIfAborted();
  });
}

async function cleanupRegisteredCalendarWatch(args: {
  readonly db: Db;
  readonly access: GoogleCalendarAccess;
  readonly calendarId: string;
  readonly prepared: PreparedGoogleCalendarWatch;
  readonly resourceId: string;
  readonly resourceUri: string;
  readonly expiration: string | number | undefined;
}): Promise<void> {
  const stopped = await stopCalendarChannelWithLifecycleOwnership({
    accessToken: args.access.accessToken,
    channel: {
      channelId: args.prepared.channelId,
      channelToken: args.prepared.channelToken,
      resourceId: args.resourceId,
    },
  });
  if (stopped) {
    await restorePreparedCalendarWatch(args);
    return;
  }
  await retainRegisteredCalendarWatchForRetry(args);
}

async function clearPreviousCalendarChannel(args: {
  readonly db: Db;
  readonly access: GoogleCalendarAccess;
  readonly calendarId: string;
  readonly stateId: string;
  readonly currentChannelId: string;
  readonly previousChannelId: string;
}): Promise<void> {
  await args.db.transaction(async (tx) => {
    await lockGoogleCalendarLifecycle(
      tx,
      args.access.connectorId,
      args.calendarId,
    );
    await tx
      .update(googleCalendarWatchStates)
      .set({
        previousChannelId: null,
        previousChannelToken: null,
        previousResourceId: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(googleCalendarWatchStates.id, args.stateId),
          eq(googleCalendarWatchStates.channelId, args.currentChannelId),
          eq(
            googleCalendarWatchStates.previousChannelId,
            args.previousChannelId,
          ),
        ),
      );
  });
}

async function finalizePreparedCalendarWatch(args: {
  readonly db: Db;
  readonly access: GoogleCalendarAccess;
  readonly calendarId: string;
  readonly prepared: PreparedGoogleCalendarWatch;
  readonly watch: z.infer<typeof calendarWatchResponseSchema>;
  readonly allowStagedTarget?: boolean;
}): Promise<
  | {
      readonly kind: "active";
      readonly state: GoogleCalendarWatchStateRow;
      readonly recoveredEpisode: GoogleCalendarWatchActionRequiredEpisode | null;
    }
  | {
      readonly kind: "inactive";
      readonly reason: "no_consumer" | "staged_target_lost";
    }
> {
  const lifecycleSignal = AbortSignal.timeout(WATCH_LIFECYCLE_TIMEOUT_MS);
  const currentTime = nowDate();
  return await args.db.transaction(async (tx) => {
    await lockGoogleCalendarLifecycle(
      tx,
      args.access.connectorId,
      args.calendarId,
    );
    const current = await loadCalendarWatchState(
      {
        db: tx,
        connectorId: args.access.connectorId,
        calendarId: args.calendarId,
      },
      lifecycleSignal,
    );
    if (
      !current ||
      current.id !== args.prepared.stateId ||
      current.channelId !== args.prepared.channelId
    ) {
      if (args.allowStagedTarget === true) {
        return { kind: "inactive", reason: "staged_target_lost" };
      }
      throw new Error("Failed to load pending Google Calendar watch state");
    }
    const recoveredEpisode = calendarWatchActionRequiredEpisode(current);
    const hasConsumer = await hasEnabledGoogleCalendarConsumer(
      {
        db: tx,
        orgId: current.orgId,
        userId: current.userId,
        connectorId: current.connectorId,
        calendarId: current.calendarId,
      },
      lifecycleSignal,
    );
    if (!hasConsumer && args.allowStagedTarget !== true) {
      return { kind: "inactive", reason: "no_consumer" };
    }
    const [updated] = await tx
      .update(googleCalendarWatchStates)
      .set({
        resourceId: args.watch.resourceId,
        resourceUri: args.watch.resourceUri,
        watchExpirationAt: watchExpirationDate(
          args.watch.expiration,
          currentTime,
        ),
        lastWatchRenewedAt: currentTime,
        needsRewatch: false,
        actionRequiredReason: null,
        actionRequiredAt: null,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(googleCalendarWatchStates.id, args.prepared.stateId),
          eq(googleCalendarWatchStates.channelId, args.prepared.channelId),
        ),
      )
      .returning({ id: googleCalendarWatchStates.id });
    if (!updated) {
      throw new Error("Failed to finalize Google Calendar watch state");
    }
    const finalized = await loadCalendarWatchState(
      {
        db: tx,
        connectorId: args.access.connectorId,
        calendarId: args.calendarId,
      },
      lifecycleSignal,
    );
    if (!finalized) {
      throw new Error("Failed to load finalized Google Calendar watch state");
    }
    return { kind: "active", state: finalized, recoveredEpisode };
  });
}

async function activatePreparedCalendarWatch(args: {
  readonly db: Db;
  readonly access: GoogleCalendarAccess;
  readonly calendarId: string;
  readonly prepared: PreparedGoogleCalendarWatch;
  readonly allowStagedTarget?: boolean;
}): Promise<
  | { readonly kind: "ok"; readonly state: GoogleCalendarWatchStateRow }
  | {
      readonly kind: "bad_request";
      readonly message: string;
      readonly providerFailure?: GoogleCalendarProviderFailure;
    }
> {
  const lifecycleSignal = AbortSignal.timeout(WATCH_LIFECYCLE_TIMEOUT_MS);
  const watch = await tapError(
    watchCalendarEvents(
      {
        accessToken: args.access.accessToken,
        calendarId: args.calendarId,
        channelId: args.prepared.channelId,
        channelToken: args.prepared.channelToken,
      },
      lifecycleSignal,
    ),
  );
  if (!watch || watch.kind !== "ok") {
    await restorePreparedCalendarWatch(args);
    return {
      kind: "bad_request",
      message:
        "Failed to register Google Calendar watch for event automation setup",
      providerFailure: calendarWatchProviderFailure(
        watch?.kind === "error" ? watch.status : 0,
      ),
    };
  }

  const finalization = await onRejection(
    finalizePreparedCalendarWatch({
      ...args,
      watch: watch.value,
    }),
    async () => {
      await cleanupRegisteredCalendarWatch({
        ...args,
        resourceId: watch.value.resourceId,
        resourceUri: watch.value.resourceUri,
        expiration: watch.value.expiration,
      });
    },
  );
  if (finalization.kind === "inactive") {
    await cleanupRegisteredCalendarWatch({
      ...args,
      resourceId: watch.value.resourceId,
      resourceUri: watch.value.resourceUri,
      expiration: watch.value.expiration,
    });
    return {
      kind: "bad_request",
      message:
        finalization.reason === "staged_target_lost"
          ? "Google Calendar watch target changed during setup"
          : "Google Calendar watch no longer has an enabled automation",
    };
  }

  const state = finalization.state;
  if (finalization.recoveredEpisode) {
    logCalendarWatchActionRequiredRecovery({
      watchStateId: state.id,
      episode: finalization.recoveredEpisode,
      targetType: googleCalendarWatchTargetType(state.calendarId),
    });
  }
  const previous = previousCalendarChannel(state);
  if (previous) {
    const stopped = await stopCalendarChannelWithLifecycleOwnership({
      accessToken: args.access.accessToken,
      channel: previous,
    });
    if (stopped) {
      await clearPreviousCalendarChannel({
        db: args.db,
        access: args.access,
        calendarId: args.calendarId,
        stateId: state.id,
        currentChannelId: state.channelId,
        previousChannelId: previous.channelId,
      });
    }
  }

  return { kind: "ok", state };
}

interface EnsureGoogleCalendarWatchArgs {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly calendarId?: string;
  readonly forceRefresh?: boolean;
  readonly reportProviderFailure?: boolean;
}

interface EnsureGoogleCalendarWatchInternalArgs extends EnsureGoogleCalendarWatchArgs {
  readonly allowStagedTarget?: boolean;
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
  | Exclude<EnsureGoogleCalendarWatchResult, { readonly kind: "ok" }>;

async function ensureGoogleCalendarWatchForUserInternal(
  args: EnsureGoogleCalendarWatchInternalArgs,
  signal: AbortSignal,
): Promise<EnsureGoogleCalendarWatchResult> {
  const calendarId = args.calendarId ?? GOOGLE_CALENDAR_PRIMARY_ID;
  const accessResult = await resolveGoogleCalendarAccess(args, signal);
  signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return accessResult;
  }

  const prepared = await args.db.transaction(async (tx) => {
    // Principal replacement owns the account lock before it snapshots and
    // removes watches, so every new watch target must follow the same order.
    await lockConnectorAccountTarget(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "builtin", connectorSlug: "google-calendar" },
    });
    const lockedAccessResult = await resolveGoogleCalendarAccess(
      { ...args, db: tx, refreshExpiredToken: false },
      signal,
    );
    if (lockedAccessResult.kind !== "ok") {
      return lockedAccessResult;
    }
    await lockGoogleCalendarLifecycle(
      tx,
      lockedAccessResult.access.connectorId,
      calendarId,
    );
    signal.throwIfAborted();

    const hasConsumer = await hasEnabledGoogleCalendarConsumer(
      {
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
        calendarId,
      },
      signal,
    );
    if (!hasConsumer && args.allowStagedTarget !== true) {
      return { kind: "unchanged" } as const;
    }

    const existing = await loadCalendarWatchState(
      {
        db: tx,
        connectorId: lockedAccessResult.access.connectorId,
        calendarId,
      },
      signal,
    );
    const currentTime = nowDate();
    if (
      existing &&
      !args.forceRefresh &&
      !watchNeedsRefresh(existing, currentTime)
    ) {
      return { kind: "unchanged" } as const;
    }

    const watch = await prepareCalendarWatch(
      {
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        access: lockedAccessResult.access,
        calendarId,
        previousState: existing,
        resetBaseline:
          existing === null ||
          args.forceRefresh === true ||
          existing.syncToken === null ||
          existing.actionRequiredReason !== null,
      },
      signal,
    );
    return watch.kind === "prepared"
      ? { ...watch, access: lockedAccessResult.access }
      : watch;
  });
  if (prepared.kind === "unchanged") {
    return { kind: "ok" };
  }
  if (prepared.kind === "bad_request") {
    return prepared;
  }

  const registered = await activatePreparedCalendarWatch({
    db: args.db,
    access: prepared.access,
    calendarId,
    prepared: prepared.prepared,
    allowStagedTarget: args.allowStagedTarget,
  });
  if (registered.kind === "ok") {
    log.debug("Workflow watch lifecycle reconciled", {
      provider: "google_calendar",
      action: "ensure",
      result: "ok",
    });
  } else if (
    registered.providerFailure &&
    args.reportProviderFailure !== false
  ) {
    logCalendarWatchProviderFailure("ensure", registered.providerFailure);
  }
  return registered.kind === "ok"
    ? { kind: "ok" }
    : {
        kind: "bad_request",
        message: registered.message,
        ...(registered.providerFailure
          ? { providerFailure: registered.providerFailure }
          : {}),
      };
}

export async function ensureGoogleCalendarWatchForUser(
  args: EnsureGoogleCalendarWatchArgs,
  signal: AbortSignal,
): Promise<EnsureGoogleCalendarWatchResult> {
  return await ensureGoogleCalendarWatchForUserInternal(args, signal);
}

/**
 * Establish a provider-ready watch before an automation starts consuming it.
 * The returned target remains owned by the caller until the automation switch
 * commits; callers must release it on every failed persistence path.
 */
export async function stageGoogleCalendarWatchTargetForReconfiguration(
  args: EnsureGoogleCalendarWatchArgs & { readonly calendarId: string },
  signal: AbortSignal,
): Promise<StageGoogleCalendarWatchTargetResult> {
  const result = await ensureGoogleCalendarWatchForUserInternal(
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
}

interface LegacyPrimaryCalendarMigrationArgs {
  readonly db: Db;
  readonly access: GoogleCalendarAccess;
  readonly legacyCalendarId: string;
  readonly orgId: string;
  readonly userId: string;
}

async function persistLegacyPrimaryCalendarMigration(
  args: LegacyPrimaryCalendarMigrationArgs,
  signal: AbortSignal,
): Promise<GoogleCalendarWatchStateRow | null> {
  return await args.db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "builtin", connectorSlug: "google-calendar" },
    });
    await lockGoogleCalendarLifecycle(
      tx,
      args.access.connectorId,
      args.legacyCalendarId,
    );
    await lockGoogleCalendarLifecycle(
      tx,
      args.access.connectorId,
      GOOGLE_CALENDAR_PRIMARY_ID,
    );
    signal.throwIfAborted();

    const legacyState = await loadCalendarWatchState(
      {
        db: tx,
        connectorId: args.access.connectorId,
        calendarId: args.legacyCalendarId,
      },
      signal,
    );
    const primaryState = await loadCalendarWatchState(
      {
        db: tx,
        connectorId: args.access.connectorId,
        calendarId: GOOGLE_CALENDAR_PRIMARY_ID,
      },
      signal,
    );
    if (
      !legacyState ||
      !primaryState ||
      legacyState.orgId !== args.orgId ||
      legacyState.userId !== args.userId ||
      primaryState.orgId !== args.orgId ||
      primaryState.userId !== args.userId ||
      legacyState.resourceId.length === 0 ||
      primaryState.resourceId.length === 0 ||
      // Google defines resourceId as the stable opaque identity of the watched
      // resource. A successful primary registration alone is not migration
      // proof because the unavailable target may be a shared calendar.
      legacyState.resourceId !== primaryState.resourceId ||
      primaryState.syncToken === null ||
      primaryState.needsRewatch ||
      calendarWatchActionRequiredEpisode(primaryState) !== null ||
      previousCalendarChannel(primaryState)
    ) {
      return null;
    }
    const hasLegacyConsumer = await hasEnabledGoogleCalendarConsumer(
      {
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.access.connectorId,
        calendarId: args.legacyCalendarId,
      },
      signal,
    );
    if (!hasLegacyConsumer) {
      return null;
    }

    const migrated = await migrateGoogleCalendarAutomationTargets(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.access.connectorId,
        fromCalendarId: args.legacyCalendarId,
        toCalendarId: GOOGLE_CALENDAR_PRIMARY_ID,
      },
      signal,
    );
    if (migrated === 0) {
      return null;
    }
    const currentTime = nowDate();
    const [updated] = await tx
      .update(googleCalendarWatchStates)
      .set({
        previousChannelId: legacyState.channelId,
        previousChannelToken: legacyState.channelToken,
        previousResourceId: legacyState.resourceId,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(googleCalendarWatchStates.id, primaryState.id),
          isNull(googleCalendarWatchStates.previousChannelId),
          isNull(googleCalendarWatchStates.previousChannelToken),
          isNull(googleCalendarWatchStates.previousResourceId),
        ),
      )
      .returning();
    if (!updated) {
      throw new Error("Failed to stage legacy Google Calendar watch cleanup");
    }
    await tx
      .delete(googleCalendarWatchStates)
      .where(eq(googleCalendarWatchStates.id, legacyState.id));
    signal.throwIfAborted();
    return updated;
  });
}

async function migrateLegacyPrimaryCalendarWatch(
  args: LegacyPrimaryCalendarMigrationArgs,
  signal: AbortSignal,
): Promise<boolean> {
  const ensured = await stageGoogleCalendarWatchTargetForReconfiguration(
    {
      db: args.db,
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

  const migratedState = await persistLegacyPrimaryCalendarMigration(
    args,
    signal,
  );

  if (!migratedState) {
    await reconcileGoogleCalendarWatchState(
      {
        db: args.db,
        connectorId: args.access.connectorId,
        calendarId: GOOGLE_CALENDAR_PRIMARY_ID,
      },
      signal,
    );
    return false;
  }

  const previous = previousCalendarChannel(migratedState);
  if (previous) {
    const stopped = await stopCalendarChannelWithLifecycleOwnership({
      accessToken: args.access.accessToken,
      channel: previous,
    });
    if (stopped) {
      await clearPreviousCalendarChannel({
        db: args.db,
        access: args.access,
        calendarId: GOOGLE_CALENDAR_PRIMARY_ID,
        stateId: migratedState.id,
        currentChannelId: migratedState.channelId,
        previousChannelId: previous.channelId,
      });
    }
  }
  return true;
}

type GoogleCalendarWatchReconcileDecision =
  | GoogleCalendarWatchReconcileResult
  | {
      readonly kind: "action_required";
      readonly access: GoogleCalendarAccess;
      readonly state: GoogleCalendarWatchStateRow;
      readonly episode: GoogleCalendarWatchActionRequiredEpisode;
    }
  | {
      readonly kind: "prepared";
      readonly access: GoogleCalendarAccess;
      readonly prepared: PreparedGoogleCalendarWatch;
      readonly state: GoogleCalendarWatchStateRow;
    };

function calendarWatchRenewalDue(args: {
  readonly state: GoogleCalendarWatchStateRow;
  readonly hasConsumer: boolean;
  readonly renewBefore?: Date;
}): boolean {
  return (
    args.hasConsumer &&
    args.renewBefore !== undefined &&
    (args.state.actionRequiredReason !== null ||
      args.state.needsRewatch ||
      args.state.watchExpirationAt.getTime() <= args.renewBefore.getTime())
  );
}

async function markCalendarWatchNeedsRewatch(
  db: Db,
  stateId: string,
): Promise<void> {
  await db
    .update(googleCalendarWatchStates)
    .set({ needsRewatch: true, updatedAt: nowDate() })
    .where(eq(googleCalendarWatchStates.id, stateId));
}

async function cleanupPreviousCalendarChannel(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly previous: GoogleCalendarChannelIdentity;
  readonly accessToken: string;
  readonly hasConsumer: boolean;
  readonly renewalDue: boolean;
}): Promise<
  | { readonly kind: "continue"; readonly state: GoogleCalendarWatchStateRow }
  | { readonly kind: "unchanged" }
  | { readonly kind: "failed" }
> {
  const stopped = await stopCalendarChannelWithLifecycleOwnership({
    accessToken: args.accessToken,
    channel: args.previous,
  });
  if (!stopped) {
    return { kind: "failed" };
  }
  await args.db
    .update(googleCalendarWatchStates)
    .set({
      previousChannelId: null,
      previousChannelToken: null,
      previousResourceId: null,
      updatedAt: nowDate(),
    })
    .where(eq(googleCalendarWatchStates.id, args.state.id));
  if (args.hasConsumer && !args.renewalDue) {
    return { kind: "unchanged" };
  }
  return {
    kind: "continue",
    state: {
      ...args.state,
      previousChannelId: null,
      previousChannelToken: null,
      previousResourceId: null,
    },
  };
}

async function prepareCalendarWatchRenewal(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly access: GoogleCalendarAccess;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarWatchReconcileDecision> {
  const prepared = await prepareCalendarWatch(
    {
      db: args.db,
      orgId: args.state.orgId,
      userId: args.state.userId,
      access: args.access,
      calendarId: args.state.calendarId,
      previousState: args.state,
      resetBaseline:
        args.state.syncToken === null ||
        args.state.actionRequiredReason !== null,
    },
    signal,
  );
  if (prepared.kind !== "prepared") {
    const episode = calendarWatchActionRequiredEpisode(args.state);
    if (episode) {
      log.debug("Workflow watch action-required retry failed", {
        provider: "google_calendar",
        action: "renew",
        result: "provider_error",
        reason: episode.reason,
        watchStateId: args.state.id,
        episodeStartedAt: episode.startedAt.toISOString(),
        targetType: googleCalendarWatchTargetType(args.state.calendarId),
      });
    } else {
      log.warn("Workflow watch lifecycle reconciliation failed", {
        provider: "google_calendar",
        action: "renew",
        result: "provider_error",
      });
    }
    return { kind: "failed" };
  }
  return {
    kind: "prepared",
    access: args.access,
    prepared: prepared.prepared,
    state: args.state,
  };
}

async function stopCurrentCalendarWatch(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly accessToken: string;
}): Promise<GoogleCalendarWatchReconcileResult> {
  if (args.state.resourceId.length === 0) {
    await markCalendarWatchNeedsRewatch(args.db, args.state.id);
    return { kind: "failed" };
  }
  const stopped = await stopCalendarChannelWithLifecycleOwnership({
    accessToken: args.accessToken,
    channel: {
      channelId: args.state.channelId,
      channelToken: args.state.channelToken,
      resourceId: args.state.resourceId,
    },
  });
  if (!stopped) {
    await markCalendarWatchNeedsRewatch(args.db, args.state.id);
    return { kind: "failed" };
  }
  await args.db
    .delete(googleCalendarWatchStates)
    .where(eq(googleCalendarWatchStates.id, args.state.id));
  log.debug("Workflow watch lifecycle reconciled", {
    provider: "google_calendar",
    action: "stop",
    result: "ok",
  });
  return { kind: "stopped" };
}

async function decideGoogleCalendarWatchReconciliation(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly calendarId: string;
    readonly forceStop?: boolean;
    readonly renewBefore?: Date;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarWatchReconcileDecision> {
  const observedState = await loadCalendarWatchState(
    {
      db: args.db,
      connectorId: args.connectorId,
      calendarId: args.calendarId,
    },
    signal,
  );
  if (!observedState) {
    return { kind: "unchanged" };
  }
  // Keep the account -> lifecycle lock order consistent with connector
  // replacement and deletion cleanup.
  await lockConnectorAccountTarget(args.db, {
    orgId: observedState.orgId,
    userId: observedState.userId,
    target: { kind: "builtin", connectorSlug: "google-calendar" },
  });
  await lockGoogleCalendarLifecycle(args.db, args.connectorId, args.calendarId);
  signal.throwIfAborted();
  const state = await loadCalendarWatchState(
    {
      db: args.db,
      connectorId: args.connectorId,
      calendarId: args.calendarId,
    },
    signal,
  );
  if (!state) {
    return { kind: "unchanged" };
  }

  const hasConsumer =
    !args.forceStop &&
    (await hasEnabledGoogleCalendarConsumer(
      {
        db: args.db,
        orgId: state.orgId,
        userId: state.userId,
        connectorId: state.connectorId,
        calendarId: state.calendarId,
      },
      signal,
    ));
  const previous = previousCalendarChannel(state);
  const renewalDue = calendarWatchRenewalDue({
    state,
    hasConsumer,
    renewBefore: args.renewBefore,
  });
  if (hasConsumer && !renewalDue && !previous) {
    return { kind: "unchanged" };
  }

  const access = await resolveGoogleCalendarAccess(
    {
      db: args.db,
      orgId: state.orgId,
      userId: state.userId,
      connectorId: state.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    if (!hasConsumer) {
      await markCalendarWatchNeedsRewatch(args.db, state.id);
    }
    return { kind: "failed" };
  }

  let currentState = state;
  if (previous) {
    const cleanup = await cleanupPreviousCalendarChannel({
      db: args.db,
      state,
      previous,
      accessToken: access.access.accessToken,
      hasConsumer,
      renewalDue,
    });
    if (cleanup.kind !== "continue") {
      return cleanup;
    }
    currentState = cleanup.state;
  }

  const actionRequiredEpisode =
    calendarWatchActionRequiredEpisode(currentState);
  if (
    hasConsumer &&
    actionRequiredEpisode &&
    currentState.calendarId !== GOOGLE_CALENDAR_PRIMARY_ID
  ) {
    return {
      kind: "action_required",
      access: access.access,
      state: currentState,
      episode: actionRequiredEpisode,
    };
  }

  return hasConsumer
    ? await prepareCalendarWatchRenewal(
        {
          db: args.db,
          state: currentState,
          access: access.access,
        },
        signal,
      )
    : await stopCurrentCalendarWatch({
        db: args.db,
        state: currentState,
        accessToken: access.access.accessToken,
      });
}

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

async function reconcileActionRequiredNonPrimaryCalendarWatch(
  args: {
    readonly db: Db;
    readonly access: GoogleCalendarAccess;
    readonly state: GoogleCalendarWatchStateRow;
    readonly episode: GoogleCalendarWatchActionRequiredEpisode;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarWatchReconcileResult> {
  const exactTarget = await probeExactCalendarTarget(
    {
      accessToken: args.access.accessToken,
      calendarId: args.state.calendarId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (exactTarget === "readable") {
    const ensured = await ensureGoogleCalendarWatchForUser(
      {
        db: args.db,
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

  const migrated = await migrateLegacyPrimaryCalendarWatch(
    {
      db: args.db,
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
  await transitionCalendarWatchToActionRequired(
    { db: args.db, state: args.state, reason: "calendar_not_found" },
    signal,
  );
  logCalendarWatchActionRequiredRetry({
    state: args.state,
    episode: args.episode,
    result: "target_missing",
  });
  return { kind: "failed" };
}

async function reconcileConfirmedMissingCalendarWatch(
  args: {
    readonly db: Db;
    readonly access: GoogleCalendarAccess;
    readonly state: GoogleCalendarWatchStateRow;
    readonly providerFailure: GoogleCalendarProviderFailure;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarWatchReconcileResult> {
  if (args.state.calendarId !== GOOGLE_CALENDAR_PRIMARY_ID) {
    const migrated = await migrateLegacyPrimaryCalendarWatch(
      {
        db: args.db,
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
  await transitionCalendarWatchToActionRequired(
    {
      db: args.db,
      state: args.state,
      reason:
        args.state.calendarId === GOOGLE_CALENDAR_PRIMARY_ID
          ? "reconnect_required"
          : "calendar_not_found",
    },
    signal,
  );
  return { kind: "failed" };
}

async function reconcileGoogleCalendarWatchState(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly calendarId: string;
    readonly forceStop?: boolean;
    readonly renewBefore?: Date;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarWatchReconcileResult> {
  const decision = await args.db.transaction(async (tx) => {
    return await decideGoogleCalendarWatchReconciliation(
      {
        ...args,
        db: tx,
      },
      signal,
    );
  });
  if (decision.kind === "action_required") {
    return await reconcileActionRequiredNonPrimaryCalendarWatch(
      {
        db: args.db,
        access: decision.access,
        state: decision.state,
        episode: decision.episode,
      },
      signal,
    );
  }
  if (decision.kind !== "prepared") {
    return decision;
  }

  const registered = await activatePreparedCalendarWatch({
    db: args.db,
    access: decision.access,
    calendarId: args.calendarId,
    prepared: decision.prepared,
  });
  if (registered.kind !== "ok") {
    if (registered.providerFailure?.status === 404) {
      const exactTarget = await probeExactCalendarTarget(
        {
          accessToken: decision.access.accessToken,
          calendarId: args.calendarId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (exactTarget === "missing") {
        return await reconcileConfirmedMissingCalendarWatch(
          {
            db: args.db,
            access: decision.access,
            state: decision.state,
            providerFailure: registered.providerFailure,
          },
          signal,
        );
      }
    }
    const actionRequiredEpisode = calendarWatchActionRequiredEpisode(
      decision.state,
    );
    if (actionRequiredEpisode) {
      logCalendarWatchActionRequiredRetry({
        state: decision.state,
        episode: actionRequiredEpisode,
        result: "provider_error",
      });
    } else if (registered.providerFailure) {
      logCalendarWatchProviderFailure("renew", registered.providerFailure);
    } else {
      log.warn("Workflow watch lifecycle reconciliation failed", {
        provider: "google_calendar",
        action: "renew",
        result: "provider_error",
      });
    }
    return { kind: "failed" };
  }
  log.debug("Workflow watch lifecycle reconciled", {
    provider: "google_calendar",
    action: "renew",
    result: "ok",
  });
  return { kind: "renewed" };
}

export async function reconcileGoogleCalendarWatchTarget(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly calendarId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const result = await reconcileGoogleCalendarWatchState(args, signal);
  return result.kind !== "failed";
}

export async function releaseStagedGoogleCalendarWatchTarget(
  args: {
    readonly db: Db;
    readonly stagedTarget: StagedGoogleCalendarWatchTarget;
  },
  signal: AbortSignal,
): Promise<boolean> {
  return await reconcileGoogleCalendarWatchTarget(
    { db: args.db, ...args.stagedTarget },
    signal,
  );
}

export async function reconcileGoogleCalendarWatchesForUser(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId?: string;
    readonly calendarId?: string;
    readonly renewBefore?: Date;
  },
  signal: AbortSignal,
): Promise<boolean> {
  let succeeded = await repairAndEnsureGoogleCalendarWatchesForOwner(
    args,
    signal,
  );

  const states = await args.db
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
    const result = await reconcileGoogleCalendarWatchState(
      {
        db: args.db,
        connectorId: state.connectorId,
        calendarId: state.calendarId,
        renewBefore: args.renewBefore,
      },
      signal,
    );
    succeeded &&= result.kind !== "failed";
  }
  return succeeded;
}

async function repairAndEnsureGoogleCalendarWatchesForOwner(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId?: string;
    readonly calendarId?: string;
    readonly ensureRefreshRequired?: boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  await repairGoogleCalendarAutomationProjections(args.db, args);
  signal.throwIfAborted();
  const targets = await loadEnabledGoogleCalendarTargets(args.db, args);
  const existingStates = await args.db
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
    const ensured = await ensureGoogleCalendarWatchForUser(
      {
        db: args.db,
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
}

async function repairGoogleCalendarAutomationProjections(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, {
      ...args,
      target: { kind: "builtin", connectorSlug: "google-calendar" },
    });
    await reprojectGoogleCalendarAutomationsForOwner(tx, args);
  });
}

async function loadEnabledGoogleCalendarTargets(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId?: string;
    readonly calendarId?: string;
  },
): Promise<
  readonly { readonly connectorId: string; readonly calendarId: string }[]
> {
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
    { readonly connectorId: string; readonly calendarId: string }
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
}

async function loadMissingGoogleCalendarWatchTargets(db: Db): Promise<
  readonly {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly calendarId: string;
  }[]
> {
  const consumers = await db
    .select({
      orgId: workflowAutomations.orgId,
      userId: workflowAutomations.ownerUserId,
      connectorId: workflowAutomations.eventConnectorId,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.kind, "event"),
        isNotNull(workflowAutomations.eventConnectorId),
        inArray(workflowAutomations.eventType, [
          ...GOOGLE_CALENDAR_EVENT_TYPES,
        ]),
      ),
    );
  const states = await db
    .select({
      connectorId: googleCalendarWatchStates.connectorId,
      calendarId: googleCalendarWatchStates.calendarId,
    })
    .from(googleCalendarWatchStates);
  const existingKeys = new Set(
    states.map((state) => {
      return `${state.connectorId}\n${state.calendarId}`;
    }),
  );
  const missing = new Map<
    string,
    {
      readonly orgId: string;
      readonly userId: string;
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
    if (!config) {
      continue;
    }
    const watchKey = `${consumer.connectorId}\n${config.calendarId}`;
    if (existingKeys.has(watchKey)) {
      continue;
    }
    missing.set(watchKey, {
      orgId: consumer.orgId,
      userId: consumer.userId,
      connectorId: consumer.connectorId,
      calendarId: config.calendarId,
    });
  }
  return [...missing.values()];
}

export async function prepareGoogleCalendarWatchStopForConnector(
  args: {
    readonly db: Tx;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<PendingGoogleCalendarWatchStop | null> {
  // Hold both ownership levels until the caller's deletion/replacement
  // transaction commits, then stop the exact captured channels post-commit.
  await lockConnectorAccountTarget(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "builtin", connectorSlug: "google-calendar" },
  });
  const targets = await args.db
    .select({ calendarId: googleCalendarWatchStates.calendarId })
    .from(googleCalendarWatchStates)
    .where(
      and(
        eq(googleCalendarWatchStates.orgId, args.orgId),
        eq(googleCalendarWatchStates.userId, args.userId),
        eq(googleCalendarWatchStates.connectorId, args.connectorId),
      ),
    )
    .orderBy(googleCalendarWatchStates.calendarId);
  for (const target of targets) {
    await lockGoogleCalendarLifecycle(
      args.db,
      args.connectorId,
      target.calendarId,
    );
  }
  signal.throwIfAborted();
  const states = await args.db
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
    const previous = previousCalendarChannel(state);
    if (previous) {
      channels.set(`${previous.channelId}\n${previous.resourceId}`, previous);
    }
  }
  if (channels.size === 0) {
    return null;
  }
  const access = await resolveGoogleCalendarAccess(
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
}

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

function decodeCalendarWebhookHeaders(
  headers: Headers,
): GoogleCalendarWebhookNotification | { readonly kind: "bad_request" } {
  const channelId = headers.get("x-goog-channel-id");
  const channelToken = headers.get("x-goog-channel-token");
  const resourceId = headers.get("x-goog-resource-id");
  const resourceState = headers.get("x-goog-resource-state");
  if (!channelId || !channelToken || !resourceId || !resourceState) {
    return { kind: "bad_request" };
  }
  return {
    channelId,
    channelToken,
    resourceId,
    resourceState,
    messageNumber: headers.get("x-goog-message-number"),
  };
}

async function loadCalendarWatchStateForNotification(
  args: {
    readonly db: Db;
    readonly notification: GoogleCalendarWebhookNotification;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarWatchStateRow | null> {
  const [state] = await args.db
    .select()
    .from(googleCalendarWatchStates)
    .where(
      or(
        and(
          eq(googleCalendarWatchStates.channelId, args.notification.channelId),
          eq(
            googleCalendarWatchStates.channelToken,
            args.notification.channelToken,
          ),
          or(
            eq(
              googleCalendarWatchStates.resourceId,
              args.notification.resourceId,
            ),
            eq(googleCalendarWatchStates.resourceId, ""),
          ),
        ),
        and(
          eq(
            googleCalendarWatchStates.previousChannelId,
            args.notification.channelId,
          ),
          eq(
            googleCalendarWatchStates.previousChannelToken,
            args.notification.channelToken,
          ),
          eq(
            googleCalendarWatchStates.previousResourceId,
            args.notification.resourceId,
          ),
        ),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!state) {
    return null;
  }
  const pendingCurrentChannel =
    state.channelId === args.notification.channelId &&
    state.channelToken === args.notification.channelToken &&
    state.resourceId.length === 0;
  if (!pendingCurrentChannel) {
    return state;
  }

  await args.db
    .update(googleCalendarWatchStates)
    .set({
      resourceId: args.notification.resourceId,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(googleCalendarWatchStates.id, state.id),
        eq(googleCalendarWatchStates.channelId, args.notification.channelId),
        eq(googleCalendarWatchStates.resourceId, ""),
      ),
    );
  signal.throwIfAborted();
  return { ...state, resourceId: args.notification.resourceId };
}

async function loadCalendarEventSnapshotMap(
  args: {
    readonly db: Db;
    readonly watchStateId: string;
    readonly events: readonly GoogleCalendarEvent[];
  },
  signal: AbortSignal,
): Promise<Map<string, GoogleCalendarEventSnapshotRow>> {
  const ids = args.events.map((event) => {
    return event.id;
  });
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await args.db
    .select()
    .from(googleCalendarEventSnapshots)
    .where(
      and(
        eq(googleCalendarEventSnapshots.watchStateId, args.watchStateId),
        inArray(googleCalendarEventSnapshots.calendarEventId, ids),
      ),
    );
  signal.throwIfAborted();
  return new Map(
    rows.map((row) => {
      return [row.calendarEventId, row];
    }),
  );
}

function parseGoogleCalendarEventAutomationConfig(
  automation: Pick<AutomationRow, "eventType" | "eventConfig">,
): { readonly calendarId: string } | null {
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

async function loadGoogleCalendarEventAutomations(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarEventAutomationRow[]> {
  const automationRows = await args.db
    .select({
      automation: workflowAutomationColumns(),
      agentId: workflows.agentId,
      workflowName: workflows.name,
      workflowDisplayName: workflows.displayName,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          workflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          workflowAutomations.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(workflowAutomations.orgId, args.state.orgId),
        eq(workflowAutomations.ownerUserId, args.state.userId),
        eq(workflowAutomations.eventConnectorId, args.state.connectorId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.kind, "event"),
        inArray(workflowAutomations.eventType, [
          "google-calendar-event-created",
          "google-calendar-event-updated",
          "google-calendar-event-cancelled",
        ]),
      ),
    );
  signal.throwIfAborted();

  const currentTime = nowDate();
  const automations: GoogleCalendarEventAutomationRow[] = [];
  for (const row of automationRows) {
    const config = parseGoogleCalendarEventAutomationConfig(row.automation);
    if (!config || config.calendarId !== args.state.calendarId) {
      continue;
    }
    const canFire = await workflowAutomationCanFire(
      args.db,
      {
        automation: row.automation,
        agentId: row.agentId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!canFire) {
      continue;
    }
    const chatThreadId =
      row.chatThreadId ??
      (await args.db.transaction(async (tx) => {
        return await ensureWorkflowUserAutomationThread(tx, {
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
          workflowId: row.automation.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
    signal.throwIfAborted();
    automations.push({
      automation: row.automation,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId,
    });
  }
  return automations;
}

function googleCalendarTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly event: CalendarEventContext;
  readonly eventChangeKey: string;
}): WorkflowAutomationContext {
  const changed =
    args.event.changeType === "created"
      ? "was created"
      : args.event.changeType === "updated"
        ? "was updated"
        : "was cancelled";
  return {
    workflowName: args.workflowName,
    eventType:
      args.event.changeType === "created"
        ? "google-calendar-event-created"
        : args.event.changeType === "updated"
          ? "google-calendar-event-updated"
          : "google-calendar-event-cancelled",
    trigger: `Google Calendar event ${args.event.eventId} on calendar ${args.event.calendarId} ${changed} (change ${args.eventChangeKey}).`,
    notes: [
      "Connected Google Calendar tools return further calendar event detail.",
    ],
    event: {
      automationId: args.automationId,
      eventChangeKey: args.eventChangeKey,
      changeType: args.event.changeType,
      calendarId: args.event.calendarId,
      eventId: args.event.eventId,
      summary: args.event.summary,
      status: args.event.status,
      eventType: args.event.eventType,
      htmlLink: args.event.htmlLink,
      start: args.event.start,
      end: args.event.end,
      organizer: args.event.organizer,
      attendees: args.event.attendees.slice(0, ATTENDEE_PROMPT_LIMIT),
      attendeeCount: args.event.attendees.length,
      created: args.event.created,
      updated: args.event.updated,
      recurringEventId: args.event.recurringEventId,
      originalStartTime: args.event.originalStartTime,
      changedFields: args.event.changedFields,
      previousSnapshot: args.event.previousSnapshot,
    },
  };
}

async function persistCurrentGoogleCalendarAutomationSource(
  tx: WorkflowQueueAdmissionTransaction,
  args: {
    readonly automationId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSourceId: string;
    readonly watchStateId: string;
    readonly calendarId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await lockConnectorAccountTarget(tx, {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "builtin", connectorSlug: "google-calendar" },
  });
  const [currentState] = await tx
    .select({ id: googleCalendarWatchStates.id })
    .from(googleCalendarWatchStates)
    .where(
      and(
        eq(googleCalendarWatchStates.id, args.watchStateId),
        eq(googleCalendarWatchStates.orgId, args.orgId),
        eq(googleCalendarWatchStates.userId, args.userId),
        eq(googleCalendarWatchStates.connectorId, args.connectorSourceId),
        eq(googleCalendarWatchStates.calendarId, args.calendarId),
        isNull(googleCalendarWatchStates.actionRequiredReason),
        isNull(googleCalendarWatchStates.actionRequiredAt),
      ),
    )
    .for("key share")
    .limit(1);
  const [current] = await tx
    .select({
      id: workflowAutomations.id,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventConnectorId, args.connectorSourceId),
        inArray(workflowAutomations.eventType, [
          ...GOOGLE_CALENDAR_EVENT_TYPES,
        ]),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (
    !currentState ||
    !current ||
    parseGoogleCalendarEventAutomationConfig(current)?.calendarId !==
      args.calendarId
  ) {
    throw new GoogleCalendarAutomationSourceChangedError();
  }
}

const startGoogleCalendarAutomationRun$ = command(
  async (
    { set },
    args: {
      readonly automation: GoogleCalendarEventAutomationRow;
      readonly state: GoogleCalendarWatchStateRow;
      readonly event: CalendarEventContext;
      readonly eventChangeKey: string;
      readonly timing: AutomationEventRunTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<"ok" | "error" | "superseded"> => {
    const runInput = await args.timing.measure(
      "api_dispatch_pre_create_agent_automation_event_build_run_input",
      () => {
        const context = googleCalendarTriggerContext({
          workflowName: args.automation.workflowName,
          automationId: args.automation.automation.id,
          event: args.event,
          eventChangeKey: args.eventChangeKey,
        });
        return { context };
      },
    );
    signal.throwIfAborted();
    const started = await settle(
      set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation: args.automation.automation,
            agentId: args.automation.agentId,
            chatThreadId: args.automation.chatThreadId,
          },
          automationContext: runInput.context,
          connectorSourceId: args.state.connectorId,
          apiStartTime: args.apiStartTime,
          triggerSource: "automation-event",
          persistSourceTransition: async (tx) => {
            await persistCurrentGoogleCalendarAutomationSource(
              tx,
              {
                automationId: args.automation.automation.id,
                orgId: args.automation.automation.orgId,
                userId: args.automation.automation.ownerUserId,
                connectorSourceId: args.state.connectorId,
                watchStateId: args.state.id,
                calendarId: args.state.calendarId,
              },
              signal,
            );
          },
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          timing: args.timing.collectorForRunStart(),
        },
        signal,
      ),
      signal,
    );
    if (!started.ok) {
      if (started.error instanceof GoogleCalendarAutomationSourceChangedError) {
        return "superseded";
      }
      throw started.error;
    }
    return started.value.kind === "ok" || started.value.kind === "enqueued"
      ? "ok"
      : "error";
  },
);

async function insertGoogleCalendarProcessedEvent(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly automation: GoogleCalendarEventAutomationRow;
    readonly notification: GoogleCalendarWebhookNotification;
    readonly event: CalendarEventContext;
    readonly eventChangeKey: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const [processed] = await args.db
    .insert(googleCalendarProcessedEvents)
    .values({
      watchStateId: args.state.id,
      automationId: args.automation.automation.id,
      channelId: args.state.channelId,
      resourceState: args.notification.resourceState,
      calendarEventId: args.event.eventId,
      eventChangeKey: args.eventChangeKey,
      eventCreatedAt: parseGoogleDate(args.event.created ?? undefined),
      eventUpdatedAt: parseGoogleDate(args.event.updated ?? undefined),
      createdAt: nowDate(),
    })
    .onConflictDoNothing()
    .returning({ id: googleCalendarProcessedEvents.id });
  signal.throwIfAborted();

  return processed?.id ?? null;
}

async function dispatchGoogleCalendarAutomationEvent(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly automation: GoogleCalendarEventAutomationRow;
    readonly notification: GoogleCalendarWebhookNotification;
    readonly event: CalendarEventContext;
    readonly eventChangeKey: string;
    readonly timing: AutomationEventRunTiming;
    readonly startRun: GoogleCalendarRunStarter;
  },
  signal: AbortSignal,
): Promise<
  "dispatched" | "duplicate" | "superseded" | { readonly kind: "run_error" }
> {
  const processedId = await args.timing.measure(
    "api_dispatch_pre_create_agent_automation_event_record_processed_event",
    async () => {
      return await insertGoogleCalendarProcessedEvent(args, signal);
    },
  );
  if (!processedId) {
    return "duplicate";
  }

  const result = await args.startRun({
    automation: args.automation,
    state: args.state,
    notification: args.notification,
    event: args.event,
    eventChangeKey: args.eventChangeKey,
    timing: args.timing,
  });
  signal.throwIfAborted();
  if (result === "superseded") {
    await args.db
      .delete(googleCalendarProcessedEvents)
      .where(eq(googleCalendarProcessedEvents.id, processedId));
    signal.throwIfAborted();
    return "superseded";
  }
  if (result !== "ok") {
    await args.db
      .delete(googleCalendarProcessedEvents)
      .where(eq(googleCalendarProcessedEvents.id, processedId));
    signal.throwIfAborted();
    return { kind: "run_error" };
  }

  return "dispatched";
}

function googleCalendarAutomationMatchesChange(
  automation: GoogleCalendarEventAutomationRow,
  changeType: GoogleCalendarChangeType,
): boolean {
  if (changeType === "created") {
    return automation.automation.eventType === "google-calendar-event-created";
  }
  if (changeType === "updated") {
    return automation.automation.eventType === "google-calendar-event-updated";
  }
  return automation.automation.eventType === "google-calendar-event-cancelled";
}

async function dispatchCalendarEventChanges(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly notification: GoogleCalendarWebhookNotification;
    readonly changes: readonly CalendarEventChange[];
    readonly automations: readonly GoogleCalendarEventAutomationRow[];
    readonly sourceTiming: AutomationEventSourceTiming;
    readonly startRun: GoogleCalendarRunStarter;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarDispatchStateResult> {
  if (args.automations.length === 0 || args.changes.length === 0) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }
  let dispatched = 0;
  let duplicates = 0;
  for (const change of args.changes) {
    const changeTiming = args.sourceTiming.fork();
    const context = eventPromptContext(args.state.calendarId, change);
    for (const automation of args.automations) {
      const runTiming = changeTiming.createRunTiming();
      const matches = await runTiming.measure(
        "api_dispatch_pre_create_agent_automation_event_match_automations",
        () => {
          return googleCalendarAutomationMatchesChange(
            automation,
            change.changeType,
          );
        },
      );
      if (!matches) {
        continue;
      }
      const result = await dispatchGoogleCalendarAutomationEvent(
        {
          db: args.db,
          state: args.state,
          automation,
          notification: args.notification,
          event: context,
          eventChangeKey: change.eventChangeKey,
          timing: runTiming,
          startRun: args.startRun,
        },
        signal,
      );
      if (typeof result !== "string") {
        return {
          kind: "run_error",
          message: "Failed to start Google Calendar event workflow run",
        };
      }
      dispatched += result === "dispatched" ? 1 : 0;
      duplicates += result === "duplicate" ? 1 : 0;
    }
  }

  return { kind: "ok", dispatched, duplicates };
}

async function dispatchGoogleCalendarChanges(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly notification: GoogleCalendarWebhookNotification;
    readonly changes: CalendarEventsListOk;
    readonly sourceTiming: AutomationEventSourceTiming;
    readonly startRun: GoogleCalendarRunStarter;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarDispatchStateResult> {
  const snapshotMap = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_external_events",
    async () => {
      return await loadCalendarEventSnapshotMap(
        {
          db: args.db,
          watchStateId: args.state.id,
          events: args.changes.events,
        },
        signal,
      );
    },
  );
  const calendarEventChanges = args.changes.events
    .map((event) => {
      return calendarEventChangeForSnapshot({
        event,
        previous: snapshotMap.get(event.id),
      });
    })
    .filter((change): change is CalendarEventChange => {
      return change !== null;
    });

  const automations = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_automations",
    async () => {
      return await loadGoogleCalendarEventAutomations(
        {
          db: args.db,
          state: args.state,
        },
        signal,
      );
    },
  );
  const result = await dispatchCalendarEventChanges(
    {
      db: args.db,
      state: args.state,
      notification: args.notification,
      changes: calendarEventChanges,
      automations,
      sourceTiming: args.sourceTiming,
      startRun: args.startRun,
    },
    signal,
  );
  if (result.kind !== "ok") {
    return result;
  }

  const currentTime = nowDate();
  await upsertCalendarEventSnapshots(
    {
      db: args.db,
      watchStateId: args.state.id,
      events: args.changes.events,
      currentTime,
    },
    signal,
  );

  await args.db
    .update(googleCalendarWatchStates)
    .set({
      syncToken: args.changes.nextSyncToken,
      needsRewatch: false,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(googleCalendarWatchStates.id, args.state.id),
        isNull(googleCalendarWatchStates.actionRequiredReason),
        isNull(googleCalendarWatchStates.actionRequiredAt),
      ),
    );
  signal.throwIfAborted();

  return result;
}

async function dispatchGoogleCalendarWatchState(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly notification: GoogleCalendarWebhookNotification;
    readonly sourceTiming: AutomationEventSourceTiming;
    readonly startRun: GoogleCalendarRunStarter;
  },
  signal: AbortSignal,
): Promise<GoogleCalendarDispatchStateResult> {
  const actionRequiredEpisode = calendarWatchActionRequiredEpisode(args.state);
  if (actionRequiredEpisode) {
    log.debug("Workflow watch dispatch skipped", {
      provider: "google_calendar",
      action: "dispatch",
      result: "action_required",
      reason: actionRequiredEpisode.reason,
      watchStateId: args.state.id,
      episodeStartedAt: actionRequiredEpisode.startedAt.toISOString(),
      targetType: googleCalendarWatchTargetType(args.state.calendarId),
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }
  const hasConsumer = await hasCurrentGoogleCalendarWatchConsumer(args, signal);
  if (!hasConsumer) {
    log.debug("Workflow watch dispatch skipped", {
      provider: "google_calendar",
      action: "dispatch",
      result: "no_consumer",
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const access = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_source_state",
    async () => {
      return await resolveGoogleCalendarAccess(
        {
          db: args.db,
          orgId: args.state.orgId,
          userId: args.state.userId,
          connectorId: args.state.connectorId,
        },
        signal,
      );
    },
  );
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }
  const baselineInput = {
    db: args.db,
    state: args.state,
    accessToken: access.access.accessToken,
  };

  if (args.notification.resourceState === "not_exists") {
    await args.db
      .update(googleCalendarWatchStates)
      .set({ needsRewatch: true, updatedAt: nowDate() })
      .where(eq(googleCalendarWatchStates.id, args.state.id));
    signal.throwIfAborted();
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  if (!args.state.syncToken) {
    const baseline = await baselineCalendarWatchState(baselineInput, signal);
    if (baseline.kind !== "ok") {
      log.warn("Google Calendar baseline sync failed", {
        watchStateId: args.state.id,
        message: baseline.message,
      });
    }
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const changes = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_external_events",
    async () => {
      return await listCalendarEvents(
        {
          accessToken: access.access.accessToken,
          calendarId: args.state.calendarId,
          syncToken: args.state.syncToken,
        },
        signal,
      );
    },
  );
  signal.throwIfAborted();
  if (changes.kind === "stale_cursor") {
    const baseline = await baselineCalendarWatchState(baselineInput, signal);
    if (baseline.kind !== "ok") {
      log.warn("Google Calendar stale cursor baseline sync failed", {
        watchStateId: args.state.id,
        message: baseline.message,
      });
    }
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }
  if (changes.kind === "calendar_error") {
    log.warn("Google Calendar event sync failed", {
      watchStateId: args.state.id,
      message: changes.message,
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  return await dispatchGoogleCalendarChanges(
    {
      db: args.db,
      state: args.state,
      notification: args.notification,
      changes,
      sourceTiming: args.sourceTiming,
      startRun: args.startRun,
    },
    signal,
  );
}

async function hasCurrentGoogleCalendarWatchConsumer(
  args: {
    readonly db: Db;
    readonly state: GoogleCalendarWatchStateRow;
    readonly sourceTiming: AutomationEventSourceTiming;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const hasConsumer = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_automations",
    async () => {
      return await hasEnabledGoogleCalendarConsumer(
        {
          db: args.db,
          orgId: args.state.orgId,
          userId: args.state.userId,
          connectorId: args.state.connectorId,
          calendarId: args.state.calendarId,
        },
        signal,
      );
    },
  );
  if (hasConsumer) {
    return true;
  }
  await repairGoogleCalendarAutomationProjections(args.db, {
    orgId: args.state.orgId,
    userId: args.state.userId,
  });
  signal.throwIfAborted();
  return await hasEnabledGoogleCalendarConsumer(
    {
      db: args.db,
      orgId: args.state.orgId,
      userId: args.state.userId,
      connectorId: args.state.connectorId,
      calendarId: args.state.calendarId,
    },
    signal,
  );
}

export const dispatchGoogleCalendarWebhook$ = command(
  async (
    { set },
    args: {
      readonly headers: Headers;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWebhookResult> => {
    const notification = decodeCalendarWebhookHeaders(args.headers);
    if ("kind" in notification) {
      return {
        kind: "bad_request",
        message: "Missing Google Calendar webhook headers",
      };
    }

    const sourceTiming = new AutomationEventSourceTiming(
      "google_calendar",
      args.apiStartTime,
    );
    const db = set(writeDb$);
    const state = await sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_source_state",
      async () => {
        return await loadCalendarWatchStateForNotification(
          {
            db,
            notification,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (!state) {
      return { kind: "unauthorized" };
    }

    const startRun: GoogleCalendarRunStarter = async ({
      automation,
      state,
      event,
      eventChangeKey,
      timing,
    }) => {
      const beforeRunStart = googleCalendarBeforeRunStartHook.get();
      if (beforeRunStart) {
        await beforeRunStart({
          automationId: automation.automation.id,
          workflowName: automation.workflowName,
          changeType: event.changeType,
          calendarId: state.calendarId,
          eventId: event.eventId,
          summary: event.summary,
        });
        signal.throwIfAborted();
      }
      return await set(
        startGoogleCalendarAutomationRun$,
        {
          automation,
          state,
          event,
          eventChangeKey,
          timing,
          apiStartTime: args.apiStartTime,
        },
        signal,
      );
    };

    const result = await dispatchGoogleCalendarWatchState(
      {
        db,
        state,
        notification,
        sourceTiming,
        startRun,
      },
      signal,
    );
    if (result.kind !== "ok") {
      return result;
    }

    return {
      kind: "ok",
      watchStates: 1,
      dispatched: result.dispatched,
      duplicates: result.duplicates,
    };
  },
);

async function renewGoogleCalendarWatchStates(
  args: {
    readonly db: Db;
    readonly states: readonly {
      readonly connectorId: string;
      readonly calendarId: string;
    }[];
    readonly renewBefore: Date;
  },
  signal: AbortSignal,
): Promise<{ readonly renewed: number; readonly failed: number }> {
  let renewed = 0;
  let failed = 0;
  for (const state of args.states) {
    const result = await reconcileGoogleCalendarWatchState(
      {
        db: args.db,
        connectorId: state.connectorId,
        calendarId: state.calendarId,
        renewBefore: args.renewBefore,
      },
      signal,
    );
    signal.throwIfAborted();
    renewed += result.kind === "renewed" ? 1 : 0;
    failed += result.kind === "failed" ? 1 : 0;
  }
  return { renewed, failed };
}

export const renewGoogleCalendarWatches$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const renewBefore = new Date(
      currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS,
    );
    const automationOwners = await db
      .selectDistinct({
        orgId: workflowAutomations.orgId,
        userId: workflowAutomations.ownerUserId,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          isNull(workflowAutomations.eventConnectorId),
          inArray(workflowAutomations.eventType, [
            ...GOOGLE_CALENDAR_EVENT_TYPES,
          ]),
        ),
      );
    signal.throwIfAborted();

    let failed = 0;
    for (const owner of automationOwners) {
      const prepared = await repairAndEnsureGoogleCalendarWatchesForOwner(
        { db, ...owner, ensureRefreshRequired: false },
        signal,
      );
      signal.throwIfAborted();
      if (!prepared) {
        failed += 1;
        log.warn("Google Calendar watch repair failed", {
          provider: "google_calendar",
          action: "repair",
          result: "provider_error",
        });
      }
    }

    const missingTargets = await loadMissingGoogleCalendarWatchTargets(db);
    signal.throwIfAborted();
    for (const target of missingTargets) {
      const ensured = await ensureGoogleCalendarWatchForUser(
        { db, ...target },
        signal,
      );
      signal.throwIfAborted();
      if (ensured.kind !== "ok") {
        failed += 1;
        log.warn("Google Calendar watch repair failed", {
          provider: "google_calendar",
          action: "ensure_missing",
          result: "provider_error",
        });
      }
    }

    const states = await db
      .select({
        connectorId: googleCalendarWatchStates.connectorId,
        calendarId: googleCalendarWatchStates.calendarId,
      })
      .from(googleCalendarWatchStates);
    signal.throwIfAborted();

    const renewedStates = await renewGoogleCalendarWatchStates(
      { db, states, renewBefore },
      signal,
    );
    return {
      renewed: renewedStates.renewed,
      failed: failed + renewedStates.failed,
    };
  },
);

export const renewGoogleCalendarWatchScope$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const renewBefore = new Date(nowDate().getTime() + WATCH_RENEWAL_WINDOW_MS);
    const prepared = await repairAndEnsureGoogleCalendarWatchesForOwner(
      { db, ...owner, ensureRefreshRequired: false },
      signal,
    );
    signal.throwIfAborted();
    if (!prepared) {
      log.warn("Google Calendar watch repair failed", {
        provider: "google_calendar",
        action: "repair",
        result: "provider_error",
      });
    }
    const states = await db
      .select({
        connectorId: googleCalendarWatchStates.connectorId,
        calendarId: googleCalendarWatchStates.calendarId,
      })
      .from(googleCalendarWatchStates)
      .where(
        and(
          eq(googleCalendarWatchStates.orgId, owner.orgId),
          eq(googleCalendarWatchStates.userId, owner.userId),
        ),
      );
    signal.throwIfAborted();
    const renewedStates = await renewGoogleCalendarWatchStates(
      { db, states, renewBefore },
      signal,
    );
    return {
      renewed: renewedStates.renewed,
      failed: renewedStates.failed + (prepared ? 0 : 1),
    };
  },
);
