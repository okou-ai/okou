import { connectors } from "@okouai/db/schema/connector";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

export interface GoogleCalendarQueueSource {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly automationId: string;
  readonly watchStateId: string;
  readonly calendarId: string;
  readonly channelId: string;
}

export class GoogleCalendarSourceTransitionChangedError extends Error {
  constructor() {
    super("Google Calendar source changed before durable queue admission");
    this.name = "GoogleCalendarSourceTransitionChangedError";
  }
}

function googleCalendarQueueAutomationCondition(
  source: GoogleCalendarQueueSource,
) {
  return and(
    eq(workflowAutomations.id, source.automationId),
    eq(workflowAutomations.orgId, source.orgId),
    eq(workflowAutomations.ownerUserId, source.userId),
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [
      "google-calendar-event-created",
      "google-calendar-event-updated",
      "google-calendar-event-cancelled",
    ]),
    eq(workflowAutomations.enabled, true),
    eq(workflowAutomations.eventConnectorId, source.connectorId),
    eq(
      sql`${workflowAutomations.eventConfig} ->> 'calendarId'`,
      source.calendarId,
    ),
  );
}

/** Queue admission gated by the current account, consumer and channel rows. */
export function googleCalendarQueueAdmissionSql(
  source: GoogleCalendarQueueSource,
) {
  return sql`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM ${connectors}
      WHERE ${and(
        eq(connectors.id, source.connectorId),
        eq(connectors.orgId, source.orgId),
        eq(connectors.userId, source.userId),
        eq(connectors.connectorSlug, "google-calendar"),
        eq(connectors.needsReconnect, false),
      )}
    )
    AND EXISTS (
      SELECT 1 FROM ${workflowAutomations}
      WHERE ${googleCalendarQueueAutomationCondition(source)}
    )
    AND EXISTS (
      SELECT 1 FROM ${googleCalendarWatchStates}
      WHERE ${and(
        eq(googleCalendarWatchStates.id, source.watchStateId),
        eq(googleCalendarWatchStates.orgId, source.orgId),
        eq(googleCalendarWatchStates.userId, source.userId),
        eq(googleCalendarWatchStates.connectorId, source.connectorId),
        eq(googleCalendarWatchStates.calendarId, source.calendarId),
        eq(googleCalendarWatchStates.channelId, source.channelId),
        isNull(googleCalendarWatchStates.actionRequiredReason),
        isNull(googleCalendarWatchStates.actionRequiredAt),
      )}
    )`;
}
