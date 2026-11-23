import { command } from "ccstate";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, not, sql } from "drizzle-orm";

import {
  readWorkflowAutomationConnectorAccount$,
  workflowAutomationBoundConnectorEligibleSql,
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
export function googleCalendarAccountProjectionStatement(owner?: {
  readonly orgId: string;
  readonly userId: string;
}) {
  const eventScope = and(
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [...GOOGLE_CALENDAR_EVENT_TYPES]),
    owner === undefined
      ? eq(workflowAutomations.enabled, true)
      : and(
          eq(workflowAutomations.orgId, owner.orgId),
          eq(workflowAutomations.ownerUserId, owner.userId),
        ),
  );
  const repairScope =
    owner === undefined
      ? and(
          eventScope,
          not(workflowAutomationBoundConnectorEligibleSql("google-calendar")),
        )
      : eventScope;
  const selection = workflowAutomationConnectorSelectionSql({
    orgId: owner?.orgId ?? sql`${workflowAutomations.orgId}`,
    userId: owner?.userId ?? sql`${workflowAutomations.ownerUserId}`,
    workflowId: sql`${workflowAutomations.workflowId}`,
    connectorSlug: "google-calendar",
  });
  return sql`
    WITH desired AS MATERIALIZED (
      SELECT ${workflowAutomations.id} AS id,
        ${workflowAutomations.eventConnectorId} AS observed_connector_id,
        (${selection}) AS connector_id
      FROM ${workflowAutomations}
      WHERE ${repairScope}
    )
    UPDATE ${workflowAutomations}
    SET event_connector_id = desired.connector_id
    FROM desired
    WHERE ${workflowAutomations.id} = desired.id
      AND ${eventScope}
      AND ${workflowAutomations.eventConnectorId} IS NOT DISTINCT FROM desired.observed_connector_id
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
