import { command } from "ccstate";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  readWorkflowAutomationConnectorAccount$,
  workflowAutomationConnectorSelectionSql,
} from "./workflow-automation-account.service";

export const GOOGLE_CALENDAR_EVENT_TYPES = [
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
] as const;

export const GOOGLE_CALENDAR_PRIMARY_ID = "primary";

export function googleCalendarAutomationProjectionColumns() {
  return {
    id: workflowAutomations.id,
    workflowId: workflowAutomations.workflowId,
    eventConnectorId: workflowAutomations.eventConnectorId,
  };
}

export function googleCalendarAutomationProjectionCondition(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [...GOOGLE_CALENDAR_EVENT_TYPES]),
  );
}

/**
 * Publish the selected business source. No row locks: the desired account is
 * read from the statement snapshot and the conditional UPDATE re-checks the
 * current target row, so a concurrent reprojection leaves nothing to change.
 */
export function googleCalendarAccountProjectionStatement(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly chatAccountAccess?: boolean;
}) {
  const eventTypes = inArray(workflowAutomations.eventType, [
    ...GOOGLE_CALENDAR_EVENT_TYPES,
  ]);
  return sql`
    WITH desired AS (
      SELECT ${workflowAutomations.id} AS id,
        (${workflowAutomationConnectorSelectionSql({ ...args, workflowId: sql`${workflowAutomations.workflowId}`, connectorSlug: "google-calendar" })}) AS connector_id
      FROM ${workflowAutomations}
      WHERE ${workflowAutomations.orgId} = ${args.orgId}
        AND ${workflowAutomations.ownerUserId} = ${args.userId}
        AND ${workflowAutomations.kind} = 'event'
        AND ${eventTypes}
    )
    UPDATE ${workflowAutomations}
    SET event_connector_id = desired.connector_id
    FROM desired
    WHERE ${workflowAutomations.id} = desired.id
      AND ${workflowAutomations.kind} = 'event'
      AND ${eventTypes}
      AND ${workflowAutomations.eventConnectorId} IS DISTINCT FROM desired.connector_id
  `;
}

export const readGoogleCalendarAutomationConnectorId$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
    },
  ): Promise<string | null> => {
    return await set(readWorkflowAutomationConnectorAccount$, {
      ...args,
      connectorSlug: "google-calendar",
    });
  },
);
